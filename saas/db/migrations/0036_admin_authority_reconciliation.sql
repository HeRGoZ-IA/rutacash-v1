-- ============================================================
-- 0036 · Autoridad del Administrador y conciliación de diferencias · intervención R74 (§15)
-- ============================================================
-- Decisiones del propietario (docs/ADEX_RONDA_74_INTERVENCION_INTEGRAL.md §15.2, 2026-10-23):
--
-- REGLA RECTORA. El Administrador es el máximo responsable del dinero. Si una transacción no tiene definido
-- quién la autoriza, la autoridad es del Administrador responsable de capital VÁLIDO de las rutas afectadas.
-- Nunca concede acceso a otras empresas ni a rutas de otro Administrador. El SuperAdmin conserva estructura,
-- supervisión y activación estructural; NO concilia dinero. Matriz completa: tmp/r74/w1/authority-matrix.md.
--
-- RB-D3 · CONCILIACIÓN POR EL ADMINISTRADOR (sin aprobación superior). Fuentes de diferencias:
--   (a) `handover`            acta de entrega confirmada con diferencia (contado − esperado ≠ 0, 0034);
--   (b) `settlement_shortage` faltante de cuadre arrastrado en la custodia (`carried_minor`, 0014);
--   (c) `settlement_surplus`  sobrante de cuadre retenido en control (`suspense` / `unidentified`, F6-D02).
-- Cada resolución guarda esperado, contado, diferencia, resolución expresa, motivo (10+), importe, fecha,
-- ruta y actor (`difference_conciliations`, inmutable) y produce sus efectos con una operación NUEVA,
-- balanceada y auditada (`DIFFERENCE_CONCILIATION`); nunca reescribe asientos, cuadres ni cierres.
--
-- TRATAMIENTO FINANCIERO (ver tmp/r74/w1/conciliation-design.md):
--   · Cuenta nueva `route_difference(ruta)` («faltante/sobrante conciliado»), con signo y por RUTA:
--     saldo > 0 = faltantes reconocidos por la ruta; saldo < 0 = sobrantes incorporados. NO es efectivo
--     (no suma a Base, custodias ni `cashMinor`) y NO es resultado operativo (no entra en
--     `operatingResultMinor` ni en el flujo): se informa aparte en `route_panel`.
--   · Resoluciones (el Administrador elige; nada se decide por defecto):
--       route_shortage   «Reconocer como faltante de la ruta». Acta: route_base −x / route_difference +x.
--                        Cuadre: custodia −x / route_difference +x y el arrastre baja x (el trabajador deja de
--                        deberlo). Nunca crea deuda del trabajador ni ingreso.
--       worker_owes      «El trabajador repone» (SOLO faltantes de cuadre y SOLO si el Administrador lo elige):
--                        sin movimiento; el faltante sigue en su custodia como faltante PENDIENTE DEL
--                        TRABAJADOR (lo entrega en el cuadre siguiente). Puede convertirse después en
--                        `route_shortage`.
--       surplus_to_base  «Incorporar el sobrante a la Base» (con `admin_pool`: a la bolsa del responsable).
--                        Acta: route_difference −x / route_base +x (el contado ya estaba en manos del
--                        responsable). Cuadre: suspense −x / Base +x y unidentified +x / route_difference −x
--                        (el efectivo retenido pasa a la Base; su origen queda como «sobrante conciliado»).
--                        No es ganancia.
--       surplus_returned «Devolver el sobrante a su dueño» (sale del control, no es ingreso). Cuadre:
--                        suspense −x / unidentified +x. Acta: sin movimiento (el sobrante nunca entró al libro).
--   · Nunca se crea efectivo disponible sin reflejar la posición física y su contrapartida: el sobrante del
--     acta ya estaba físicamente con el responsable; el del cuadre sale de la cuenta de control que lo retenía.
--   · Tras resolver, la diferencia deja de estar pendiente: alertas e indicadores la muestran como conciliada
--     y nada en el servidor bloquea la ruta por ella (el cierre de periodo clasifica la operación nueva).
--   · Quién concilia: SOLO el Administrador responsable de capital VÁLIDO de la ruta, hoy (periodo abierto),
--     sin conciliar su propio efectivo (otra membresía de la misma persona: AX801). El SuperAdmin, el
--     Supervisor y el Cobrador ven, no concilian.
--
-- RB-D1 · Un Administrador NO se desactiva con cuentas pendientes (disparador sobre `memberships`, AX433):
--   responsable de capital de alguna ruta; bolsa ≠ 0 (también «sin asignar»); reembolsos pendientes a su favor
--   (`admin_payable` ≠ 0: el dinero no puede quedar sin responsable); actas de entrega pendientes; diferencias
--   sin conciliar en sus rutas; traspasos o solicitudes de capital pendientes; sobrantes en control a su
--   nombre; efectivo en custodia de otra membresía suya. Diagnóstico: `adex.admin_pending_accounts`.
--   Datos heredados de Administradores YA inactivos: se informan con la misma función, no se ajustan solos.
-- RB-D2 · Activar `route_base` exige la cuenta de la empresa EN CERO (la nota ya no exime; el campo se
--   conserva por compatibilidad y se rechaza igual).
-- RB-D6 · `migrating` no es obligatorio para una empresa sin saldos (todas sus cuentas en cero): activación
--   directa con todas las validaciones; con saldos que repartir o posiciones que conciliar, primero `migrating`.
-- RB-D7 · Correcciones cuando cambió el responsable: las hace el responsable VIGENTE de las rutas afectadas;
--   una operación conjunta con rutas de distintos Administradores se rechaza (AX434) salvo que el actor
--   controle TODAS, con la lista de rutas y responsables. AX432 (no anular un gasto ya reembolsado) se conserva.
--
-- Aditiva: con `admin_pool` y sin conciliaciones, cada función redefinida se comporta igual que en 0035, salvo
-- las decisiones RB-D1/RB-D2/RB-D6/RB-D7 aprobadas. No cambia ni borra filas. Generado por
-- tmp/r74/w1/build-0036.mjs (copia literal de la última definición de cada función con reemplazos exactos).

-- ============================================================
-- 1. Esquema
-- ============================================================

-- ---------- Cuenta «faltante/sobrante conciliado» por ruta ----------
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding', 'admin_payable', 'route_difference'));
alter table adex.capital_accounts drop constraint capital_accounts_shape_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check
  check (case kind
           when 'company'      then membership_id is null and route_id is null
           when 'external'     then membership_id is null and route_id is null
           when 'admin'        then membership_id is not null and route_id is null
           when 'custody'      then membership_id is not null and route_id is not null
           when 'portfolio'    then membership_id is null and route_id is not null
           when 'income'       then membership_id is null and route_id is not null
           when 'expense'      then membership_id is null
           when 'suspense'     then membership_id is not null and route_id is not null
           when 'unidentified' then membership_id is null and route_id is not null
           when 'transit'      then membership_id is null and route_id is null
           when 'route_base'    then membership_id is null and route_id is not null
           when 'route_funding' then membership_id is null and route_id is not null
           when 'admin_payable' then membership_id is not null and route_id is null
           -- RB-D3: de la RUTA, nunca de una persona; con signo; nunca efectivo.
           when 'route_difference' then membership_id is null and route_id is not null
         end);
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable', 'route_difference') or balance_minor >= 0);

-- ---------- Operación de conciliación (no anulable: es definitiva) ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION'));
alter table adex.capital_operations add constraint capital_operations_conciliation_shape
  check (kind <> 'DIFFERENCE_CONCILIATION' or (route_id is not null and to_route_id is null and admin_membership_id is not null));

-- ---------- Conciliaciones (hechos inmutables) ----------
create table adex.difference_conciliations (
  id                     adex.eid primary key,
  seq                    bigint generated always as identity,   -- orden de registro (bajo el bloqueo de la custodia)
  company_id             adex.eid not null references adex.companies(id),
  operation_id           uuid not null,                         -- X-Adex-Operation-Id
  route_id               adex.eid not null,
  source_kind            text not null check (source_kind in ('handover', 'settlement_shortage', 'settlement_surplus')),
  handover_id            adex.eid,
  settlement_id          adex.eid,                              -- cuadre de origen (faltante: el último vigente al resolver)
  custody_account_id     adex.eid,
  worker_membership_id   adex.eid,
  holder_membership_id   adex.eid,                              -- quien tenía la diferencia (acta: nuevo responsable; sobrante: titular del control)
  expected_minor         bigint not null,
  counted_minor          bigint not null,
  difference_minor       bigint not null check (difference_minor <> 0),   -- contado − esperado (con signo)
  amount_minor           bigint not null check (amount_minor > 0),        -- importe resuelto
  resolution             text not null check (resolution in ('route_shortage', 'worker_owes', 'surplus_to_base', 'surplus_returned')),
  carried_after_minor    bigint check (carried_after_minor is null or carried_after_minor >= 0),
  reason                 text not null check (length(btrim(reason)) >= 10 and length(reason) <= 500),
  ledger_operation_id    adex.eid,
  capital_model          text not null check (capital_model in ('admin_pool', 'migrating', 'route_base')),
  entry_date             date not null,
  actor_membership_id    adex.eid not null,
  actor_identity_id      uuid not null references adex.identities(id),
  actor_role             text not null check (actor_role = 'admin'),
  txid                   bigint not null,
  created_at             timestamptz not null default now(),
  unique (company_id, id),
  constraint difference_conciliations_operation_key unique (company_id, operation_id),
  constraint difference_conciliations_ledger_key unique (company_id, ledger_operation_id),
  check ((source_kind = 'handover') = (handover_id is not null)),
  check ((source_kind = 'handover') = (settlement_id is null and custody_account_id is null and worker_membership_id is null)),
  check (case source_kind when 'handover' then resolution in ('route_shortage', 'surplus_to_base', 'surplus_returned')
                          when 'settlement_shortage' then resolution in ('route_shortage', 'worker_owes')
                          else resolution in ('surplus_to_base', 'surplus_returned') end),
  check ((resolution in ('route_shortage', 'worker_owes')) = (difference_minor < 0)),
  check ((resolution = 'worker_owes' or (resolution = 'surplus_returned' and source_kind = 'handover')) = (ledger_operation_id is null)),
  check ((source_kind = 'settlement_shortage') = (carried_after_minor is not null)),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, handover_id) references adex.route_handover_records(company_id, id),
  foreign key (company_id, settlement_id) references adex.custody_settlements(company_id, id),
  foreign key (company_id, worker_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, holder_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, ledger_operation_id) references adex.capital_operations(company_id, id) deferrable initially deferred
);
-- Un acta y un sobrante de cuadre se concilian UNA vez (dos resoluciones simultáneas: exactamente una).
create unique index difference_conciliations_one_per_handover on adex.difference_conciliations (company_id, handover_id) where handover_id is not null;
create unique index difference_conciliations_one_per_surplus on adex.difference_conciliations (company_id, settlement_id) where source_kind = 'settlement_surplus';
create index difference_conciliations_route on adex.difference_conciliations (company_id, route_id, created_at);
create index difference_conciliations_custody on adex.difference_conciliations (company_id, custody_account_id, seq) where custody_account_id is not null;
do $$
begin
  execute 'create trigger difference_conciliations_immutable before update or delete on adex.difference_conciliations for each row execute function adex.reject_mutation()';
  execute 'create trigger difference_conciliations_no_truncate before truncate on adex.difference_conciliations for each statement execute function adex.reject_mutation()';
end $$;
alter table adex.difference_conciliations enable row level security;
alter table adex.difference_conciliations force row level security;
create policy owner_conciliations_all on adex.difference_conciliations for all to adex_owner using (true) with check (true);
create policy difference_conciliations_ctx on adex.difference_conciliations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or adex.ctx_membership() in (worker_membership_id, holder_membership_id)
        or ((select adex.ctx_is(array['admin', 'supervisor'])) and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.difference_conciliations to adex_api;

-- ============================================================
-- 2. Ayudantes
-- ============================================================

-- RB-D7: ¿alcanza un gasto general con aportes / un reembolso a alguna ruta del alcance del contexto?
-- (SECURITY DEFINER para no encadenar políticas entre gastos, aportes y reembolsos.)
create function adex.general_funding_in_scope(p_company text, p_expense text, p_reimbursement text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.api_scope_ok(p_company) and adex.ctx_is(array['admin', 'supervisor']) and exists (
      select 1 from adex.general_funding_contributions g
       where g.company_id = p_company and g.route_id is not null
         and ((p_expense is not null and g.expense_id = p_expense) or (p_reimbursement is not null and g.reimbursement_id = p_reimbursement))
         and adex.route_in_scope(g.route_id, adex.ctx_routes_all(), adex.ctx_route_ids()))
  $$;
revoke all on function adex.general_funding_in_scope(text, text, text) from public;
grant execute on function adex.general_funding_in_scope(text, text, text) to adex_api;

-- RB-D7: el actor debe ser el responsable de capital VÁLIDO de TODAS las rutas de una operación (o conjunta).
-- Rutas de distintos responsables → AX434 con la lista «ruta (responsable)»; una sola ruta ajena → AX402.
create function adex.require_controls_all_routes(p_company text, p_routes text[], p_actor text) returns void
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_list text; v_n int;
  begin
    if not exists (select 1 from unnest(p_routes) u(r) where adex.route_valid_controller(p_company, u.r) is distinct from p_actor) then
      return;
    end if;
    select string_agg(ro.name || ' (' || coalesce(m.display_name, 'sin responsable válido') || ')', ', ' order by ro.name, ro.id),
           count(distinct coalesce(adex.route_valid_controller(p_company, u.r), '-'))
      into v_list, v_n
      from unnest(p_routes) u(r)
      join adex.routes ro on ro.company_id = p_company and ro.id = u.r
      left join adex.memberships m on m.company_id = p_company and m.id = adex.route_valid_controller(p_company, u.r);
    if v_n > 1 then
      perform adex.capital_raise('AX434', 'the operation spans routes of different administrators; only someone who controls all of them corrects it: ' || coalesce(v_list, ''));
    end if;
    perform adex.capital_raise('AX402', 'only the current capital controller of the routes corrects this operation: ' || coalesce(v_list, ''));
  end $$;
revoke all on function adex.require_controls_all_routes(text, text[], text) from public;

-- Para explicar un rechazo AX434 en la API: rutas y su responsable vigente (solo nombres; nunca saldos).
create function adex.joint_operation_controllers(p_routes text[]) returns table (route_id text, name text, controller_id text, controller_name text, is_actor boolean)
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() then perform adex.capital_raise('42501', 'no valid active context'); end if;
    return query
      select ro.id::text, ro.name, c.ctrl, m.display_name, c.ctrl is not distinct from adex.ctx_membership()
        from unnest(p_routes) u(r)
        join adex.routes ro on ro.company_id = v_company and ro.id = u.r
        cross join lateral (select adex.route_valid_controller(v_company, ro.id)::text ctrl) c
        left join adex.memberships m on m.company_id = v_company and m.id = c.ctrl
       order by ro.name, ro.id;
  end $$;
revoke all on function adex.joint_operation_controllers(text[]) from public;
grant execute on function adex.joint_operation_controllers(text[]) to adex_api;

-- RB-D7: TODAS las rutas aportantes de un gasto general o de un reembolso (la RLS de los aportes solo deja ver las
-- del alcance propio; para explicar un rechazo conjunto hacen falta todas). Solo ids, para quien ya ve la operación.
create function adex.general_funding_routes(p_expense text, p_reimbursement text) returns text[]
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if not (adex.ctx_role() = 'superadmin' or adex.general_funding_in_scope(v_company, p_expense, p_reimbursement)
            or exists (select 1 from adex.expenses x where x.company_id = v_company and x.id = p_expense and x.responsible_admin_membership_id = adex.ctx_membership())
            or exists (select 1 from adex.admin_reimbursements r where r.company_id = v_company and r.id = p_reimbursement
                         and adex.ctx_membership() in (r.admin_membership_id, r.payer_membership_id))) then
      return '{}';
    end if;
    return coalesce((select array_agg(g.route_id::text order by g.route_id) from adex.general_funding_contributions g
                      where g.company_id = v_company and g.route_id is not null
                        and ((p_expense is not null and g.expense_id = p_expense) or (p_reimbursement is not null and g.reimbursement_id = p_reimbursement))), '{}');
  end $$;
revoke all on function adex.general_funding_routes(text, text) from public;
grant execute on function adex.general_funding_routes(text, text) to adex_api;

-- Faltante de cuadre que el Administrador decidió que el trabajador repone (`worker_owes`), aún vigente:
-- lo fijado en la última decisión, nunca más que el arrastre más bajo visto después (cuadres vigentes
-- posteriores y faltantes reconocidos por la ruta) ni que el arrastre actual. Interno.
create function adex.custody_worker_owed(p_company text, p_account text) returns bigint
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce((
      select greatest(0, least(
               r.carried_after_minor,
               coalesce((select min(d.carried_after_minor) from adex.difference_conciliations d
                          where d.company_id = r.company_id and d.custody_account_id = r.custody_account_id
                            and d.resolution = 'route_shortage' and d.seq > r.seq), r.carried_after_minor),
               coalesce((select min(s.carried_after_minor) from adex.custody_settlements s
                          join adex.custody_settlements s0 on s0.company_id = r.company_id and s0.id = r.settlement_id
                         where s.company_id = r.company_id and s.custody_account_id = r.custody_account_id
                           and s.status = 'cerrada' and s.cycle_no > s0.cycle_no), r.carried_after_minor),
               coalesce((select a.carried_minor from adex.capital_accounts a where a.company_id = r.company_id and a.id = r.custody_account_id), 0)))
        from adex.difference_conciliations r
       where r.company_id = p_company and r.custody_account_id = p_account and r.resolution = 'worker_owes'
       order by r.seq desc limit 1), 0)::bigint
  $$;
revoke all on function adex.custody_worker_owed(text, text) from public;

-- Diferencias de una ruta (o de la empresa con p_route NULL). Interno: sin comprobación de contexto.
--   handover            actas confirmadas con diferencia y sin conciliar;
--   settlement_shortage custodias con arrastre > 0 (pending = arrastre − lo decidido como del trabajador);
--   settlement_surplus  cuadres vigentes con sobrante sin conciliar.
create function adex.difference_items_internal(p_company text, p_route text)
  returns table (source_kind text, source_id text, route_id text, worker_id text, holder_id text, kind text, expected_minor bigint,
                 counted_minor bigint, difference_minor bigint, pending_minor bigint, worker_owed_minor bigint, carried_minor bigint,
                 occurred_at timestamptz, business_date date, custody_account_id text)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select 'handover'::text, h.id::text, h.route_id::text, null::text, h.to_membership_id::text,
           case when h.difference_minor < 0 then 'faltante' else 'sobrante' end,
           h.expected_base_minor, h.counted_minor, h.difference_minor, abs(h.difference_minor), 0::bigint, null::bigint,
           h.confirmed_at, (h.confirmed_at at time zone c.timezone)::date, null::text
      from adex.route_handover_records h join adex.companies c on c.id = h.company_id
     where h.company_id = p_company and (p_route is null or h.route_id = p_route) and h.status = 'confirmada' and h.difference_minor <> 0
       and not exists (select 1 from adex.difference_conciliations d where d.company_id = h.company_id and d.handover_id = h.id)
    union all
    select 'settlement_shortage'::text, s.id::text, a.route_id::text, a.membership_id::text, a.membership_id::text, 'faltante',
           s.expected_cash_minor, s.delivered_minor, -s.shortage_minor,
           a.carried_minor - w.owed, w.owed, a.carried_minor, s.closed_at, s.business_date, a.id::text
      from adex.capital_accounts a
      cross join lateral adex.custody_last_settlement(a.company_id, a.id) s
      cross join lateral (select adex.custody_worker_owed(a.company_id, a.id) owed) w
     where a.company_id = p_company and a.kind = 'custody' and (p_route is null or a.route_id = p_route) and a.carried_minor > 0 and s.id is not null
    union all
    select 'settlement_surplus'::text, s.id::text, s.route_id::text, s.worker_membership_id::text, s.receiver_admin_membership_id::text, 'sobrante',
           s.expected_cash_minor, s.delivered_minor, s.surplus_minor, s.surplus_minor, 0::bigint, null::bigint, s.closed_at, s.business_date,
           s.custody_account_id::text
      from adex.custody_settlements s
     where s.company_id = p_company and (p_route is null or s.route_id = p_route) and s.status = 'cerrada' and s.surplus_minor > 0
       and not exists (select 1 from adex.difference_conciliations d where d.company_id = s.company_id and d.settlement_id = s.id
                         and d.source_kind = 'settlement_surplus')
  $$;
revoke all on function adex.difference_items_internal(text, text) from public;

-- Resoluciones admitidas para una diferencia.
create function adex.difference_resolutions(p_source_kind text, p_kind text, p_pending bigint) returns text[]
  language sql immutable
  as $$
    select case
      when p_source_kind = 'handover' and p_kind = 'faltante' then array['route_shortage']
      when p_source_kind = 'settlement_shortage' and p_pending > 0 then array['route_shortage', 'worker_owes']
      when p_source_kind = 'settlement_shortage' then array['route_shortage']
      else array['surplus_to_base', 'surplus_returned'] end
  $$;
revoke all on function adex.difference_resolutions(text, text, bigint) from public;
grant execute on function adex.difference_resolutions(text, text, bigint) to adex_api;

-- ============================================================
-- 3. Funciones redefinidas (copia literal + cambios mínimos)
-- ============================================================

-- capital_lock_accounts: la de 0035_general_expenses_funding.sql.
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding', 'admin_payable', 'route_difference'], kind), id
      for update;
  end $$;

-- capital_ledger_checks: la de 0035_general_expenses_funding.sql.
create or replace function adex.capital_ledger_checks() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    r jsonb;
  begin
    if v_company is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'reconciliation is reserved to the SuperAdmin');
    end if;
    select jsonb_build_object(
      'mismatched', (select count(*) from adex.capital_accounts a
                      where a.company_id = v_company and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e
                                                                                      where e.company_id = a.company_id and e.account_id = a.id), 0)),
      'unbalanced', (select count(*) from adex.capital_operations o
                      where o.company_id = v_company and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e
                                                           where e.company_id = o.company_id and e.operation_id = o.id)),
      'negativeCustody', (select count(*) from adex.capital_entries e
                            join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                            join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                           where e.company_id = v_company and a.kind = 'custody' and e.amount_minor < 0 and e.balance_after_minor < 0
                             and o.kind <> 'WORKER_EXPENSE'),
      'carriedDrift', (select count(*) from adex.capital_accounts a
                        where a.company_id = v_company and a.kind = 'custody'
                          -- R74 (0036, RB-D3): menos los faltantes que la ruta reconoció sobre ese cuadre.
                          and a.carried_minor <> coalesce((select s.carried_after_minor
                                                                  - coalesce((select sum(d.amount_minor) from adex.difference_conciliations d
                                                                               where d.company_id = s.company_id and d.settlement_id = s.id
                                                                                 and d.source_kind = 'settlement_shortage' and d.resolution = 'route_shortage'), 0)
                                                             from adex.custody_settlements s where s.company_id = a.company_id
                                                            and s.custody_account_id = a.id and s.status = 'cerrada' order by s.cycle_no desc limit 1), 0)),
      'settlementDrift', (select count(*) from adex.custody_settlements s
                           where s.company_id = v_company
                             and (s.expected_position_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e
                                                                          where e.company_id = s.company_id and e.account_id = s.custody_account_id and e.seq <= s.to_seq), 0)
                                  or s.returned_to_pool_minor <> coalesce((select o.amount_minor from adex.capital_operations o where o.company_id = s.company_id
                                                                            and o.id = s.return_operation_id and o.kind = 'SETTLEMENT_RETURN' and o.settlement_id = s.id), 0)
                                  or s.surplus_minor <> coalesce((select o.amount_minor from adex.capital_operations o where o.company_id = s.company_id
                                                                   and o.id = s.surplus_operation_id and o.kind = 'SETTLEMENT_SURPLUS' and o.settlement_id = s.id), 0)
                                  or (s.status = 'reabierta') <> exists (select 1 from adex.capital_operations o where o.company_id = s.company_id and o.settlement_id = s.id
                                                                          and o.kind = 'REVERSAL') and (s.return_operation_id is not null or s.surplus_operation_id is not null))),
      'surplusDrift', (select count(*) from adex.capital_accounts a
                        where a.company_id = v_company and a.kind in ('suspense', 'unidentified')
                          -- R74 (0036, RB-D3): menos los sobrantes ya conciliados (incorporados o devueltos).
                          and abs(a.balance_minor) <> coalesce((select sum(s.surplus_minor - coalesce((select sum(d.amount_minor) from adex.difference_conciliations d
                                                                         where d.company_id = s.company_id and d.settlement_id = s.id
                                                                           and d.source_kind = 'settlement_surplus'), 0))
                                                                 from adex.custody_settlements s where s.company_id = a.company_id
                                                                 and s.route_id = a.route_id and s.status = 'cerrada'
                                                                 and (a.kind = 'unidentified' or s.receiver_admin_membership_id = a.membership_id)), 0)),
      'closedDrift', (select count(*) from adex.period_closures p
                        cross join lateral (select adex.route_period_figures(p.company_id, p.route_id, p.week_start, p.week_end) f) now
                       where p.company_id = v_company
                         and (p.figures -> 'custody' is distinct from now.f -> 'custody' or p.ledger_hash is distinct from now.f #>> '{operations,hash}')),
      -- R74 Base por Ruta (0034). Ámbito: toda pata en una cuenta CON ruta es de la ruta de la operación o de su destino.
      'routeScope', (select count(*) from adex.capital_entries e
                      join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                      join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                     where e.company_id = v_company and a.route_id is not null
                       and a.route_id is distinct from o.route_id and a.route_id is distinct from o.to_route_id),
      -- Desde el corte, ninguna bolsa recibe dinero y solo sale por el reparto confirmado de «sin asignar».
      'adminInflowAfterCutover', (select count(*) from adex.capital_entries e
                                   join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                                   join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                                   join adex.companies c on c.id = e.company_id
                                  where e.company_id = v_company and c.route_base_since is not null and o.created_at >= c.route_base_since
                                    and a.kind = 'admin' and (e.amount_minor > 0 or o.kind <> 'LEGACY_POOL_TO_ROUTE')),
      -- Conservación por ruta: desde el corte, toda operación que no cruza rutas suma cero dentro de cada ruta.
      'routeConservation', (select count(*) from (
                              select o.id, a.route_id from adex.capital_entries e
                                join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                                join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                                join adex.companies c on c.id = e.company_id
                               where e.company_id = v_company and c.route_base_since is not null and o.created_at >= c.route_base_since
                                 and a.route_id is not null
                                 and coalesce(o.reverses_kind, o.kind) not in ('ROUTE_TRANSFER', 'ROUTE_REASSIGNMENT', 'LEGACY_POOL_TO_ROUTE',
                                                                               -- R74 (0035): salen de la Base hacia un gasto general o un
                                                                               -- reembolso (cruce explícito; ver `generalFundingDrift`).
                                                                               'GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT')
                               group by o.id, a.route_id having sum(e.amount_minor) <> 0) x),
      -- R74 (0035, D74-O4F). Aportes y reembolsos: cada operación toca EXACTAMENTE la Base de SU ruta (o la bolsa de
      -- quien paga, en un reembolso sin ruta) y una cuenta sin ruta (gasto general o saldo a favor del Administrador);
      -- cada aporte tiene su fila con el mismo importe y ruta; Σ aportes = gasto (`routes`) = reembolso; y un gasto o
      -- reembolso anulado lo está en TODOS sus aportes (y solo entonces).
      'generalFundingDrift', (
          (select count(*) from adex.capital_operations o
            where o.company_id = v_company and coalesce(o.reverses_kind, o.kind) in ('GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT')
              and (select count(*) <> 2
                          or count(*) filter (where (a.kind = 'route_base' and a.route_id = o.route_id)
                                                 or (a.kind = 'admin' and o.route_id is null and coalesce(o.reverses_kind, o.kind) = 'ADMIN_REIMBURSEMENT')) <> 1
                          or count(*) filter (where (coalesce(o.reverses_kind, o.kind) = 'GENERAL_EXPENSE_CONTRIBUTION' and a.kind = 'expense' and a.route_id is null)
                                                 or (coalesce(o.reverses_kind, o.kind) = 'ADMIN_REIMBURSEMENT' and a.kind = 'admin_payable'
                                                     and a.membership_id = o.counterpart_membership_id)) <> 1
                     from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                    where e.company_id = o.company_id and e.operation_id = o.id))
        + (select count(*) from adex.capital_operations o
            where o.company_id = v_company and o.kind in ('GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT')
              and not exists (select 1 from adex.general_funding_contributions g where g.company_id = o.company_id and g.operation_id = o.id
                                and g.amount_minor = o.amount_minor and g.route_id is not distinct from o.route_id
                                and (g.purpose = 'expense') = (o.kind = 'GENERAL_EXPENSE_CONTRIBUTION')
                                and (g.expense_id is null or g.expense_id = o.expense_id)))
        + (select count(*) from adex.expenses x
            where x.company_id = v_company and x.funding = 'routes' and x.reverses_id is null and x.ledger_operation_id is not null
              and x.amount_minor <> coalesce((select sum(g.amount_minor) from adex.general_funding_contributions g
                                               where g.company_id = x.company_id and g.expense_id = x.id), 0))
        + (select count(*) from adex.admin_reimbursements r
            where r.company_id = v_company
              and r.amount_minor <> coalesce((select sum(g.amount_minor) from adex.general_funding_contributions g
                                               where g.company_id = r.company_id and g.reimbursement_id = r.id), 0))
        + (select count(*) from adex.general_funding_contributions g
             left join adex.expenses x on x.company_id = g.company_id and x.id = g.expense_id
             left join adex.admin_reimbursements r on r.company_id = g.company_id and r.id = g.reimbursement_id
            where g.company_id = v_company
              and (case when g.purpose = 'expense' then x.reversal_id is not null else r.reversed_at is not null end)
                  <> exists (select 1 from adex.capital_operations v where v.company_id = g.company_id and v.reverses_operation_id = g.operation_id))),
      -- Saldo a favor de cada Administrador = Σ gastos con dinero propio (netos de anulaciones) − Σ reembolsos vigentes.
      'adminPayableDrift', (select count(*) from adex.memberships m
                             where m.company_id = v_company
                               and coalesce((select -a.balance_minor from adex.capital_accounts a
                                              where a.company_id = m.company_id and a.kind = 'admin_payable' and a.membership_id = m.id), 0)
                                   <> coalesce((select sum(x.amount_minor) from adex.expenses x where x.company_id = m.company_id and x.funding = 'own_money'
                                                  and x.responsible_admin_membership_id = m.id and x.ledger_operation_id is not null), 0)
                                    - coalesce((select sum(r.amount_minor) from adex.admin_reimbursements r where r.company_id = m.company_id
                                                  and r.admin_membership_id = m.id and r.reversed_at is null), 0)),
      -- R74 (0036, RB-D3). Cada conciliación con movimiento tiene su operación (mismo importe y ruta) y viceversa; el saldo
      -- «faltante/sobrante conciliado» de cada ruta = Σ faltantes reconocidos − Σ sobrantes incorporados.
      'conciliationDrift', (
          (select count(*) from adex.difference_conciliations d
            where d.company_id = v_company and d.ledger_operation_id is not null
              and not exists (select 1 from adex.capital_operations o where o.company_id = d.company_id and o.id = d.ledger_operation_id
                                and o.kind = 'DIFFERENCE_CONCILIATION' and o.amount_minor = d.amount_minor and o.route_id = d.route_id))
        + (select count(*) from adex.capital_operations o
            where o.company_id = v_company and o.kind = 'DIFFERENCE_CONCILIATION'
              and not exists (select 1 from adex.difference_conciliations d where d.company_id = o.company_id and d.ledger_operation_id = o.id))
        + (select count(*) from adex.capital_accounts a
            where a.company_id = v_company and a.kind = 'route_difference'
              and a.balance_minor <> coalesce((select sum(case when d.resolution = 'route_shortage' then d.amount_minor else -d.amount_minor end)
                                                 from adex.difference_conciliations d where d.company_id = a.company_id and d.route_id = a.route_id
                                                  and d.resolution in ('route_shortage', 'surplus_to_base')), 0))))
      into r;
    return r;
  end $$;

-- capital_model_prerequisites: la de 0035_general_expenses_funding.sql.
create or replace function adex.capital_model_prerequisites() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_company_bal bigint; v_transit bigint; v_pending_transfers int; v_pending_requests int; v_routes text[]; v_ledger jsonb;
    v_overdrawn int; v_conservation numeric; v_pools jsonb; v_checks jsonb;
    v_model text; v_nonzero int;
  begin
    if v_company is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'the capital model is managed by the SuperAdmin');
    end if;
    select coalesce(sum(balance_minor) filter (where kind = 'company'), 0), coalesce(sum(balance_minor) filter (where kind = 'transit'), 0)
      into v_company_bal, v_transit from adex.capital_accounts where company_id = v_company and kind in ('company', 'transit');
    select count(*) into v_pending_transfers from adex.admin_transfers where company_id = v_company and state = 'pending';
    select count(*) into v_pending_requests from adex.capital_requests
     where company_id = v_company and state = 'pending' and kind in ('admin_return', 'admin_allocation', 'admin_transfer');
    select coalesce(array_agg(r.id::text order by r.id), '{}') into v_routes from adex.routes r
     where r.company_id = v_company and r.status = 'activa' and adex.route_valid_controller(v_company, r.id) is null;
    v_ledger := adex.capital_ledger_checks();
    select count(*) into v_overdrawn from adex.capital_accounts
     where company_id = v_company and kind not in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable', 'route_difference') and balance_minor < 0;
    select coalesce(sum(balance_minor), 0) into v_conservation from adex.capital_accounts where company_id = v_company;
    select coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'status', m.status, 'balanceMinor', a.balance_minor)
                    order by m.display_name, a.membership_id), '[]'::jsonb)
      into v_pools
      from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin' and a.balance_minor <> 0;
    -- R74 (0036, RB-D6): desde `admin_pool` la activación directa solo sin saldos (todas las cuentas en cero, sin
    -- arrastres); con saldos que repartir o posiciones que conciliar, primero `migrating`.
    v_model := adex.company_capital_model(v_company);
    select count(*) into v_nonzero from adex.capital_accounts where company_id = v_company and (balance_minor <> 0 or carried_minor <> 0);
    v_checks := jsonb_build_array(
      -- R74 (0036, RB-D2): EN CERO, con operaciones explícitas; una nota ya no lo sustituye.
      jsonb_build_object('name', 'company-account-zero', 'ok', v_company_bal = 0, 'detail', v_company_bal),
      jsonb_build_object('name', 'direct-activation-or-migrating', 'ok', v_model is distinct from 'admin_pool' or v_nonzero = 0,
                         'detail', jsonb_build_object('model', v_model, 'nonZeroAccounts', v_nonzero)),
      jsonb_build_object('name', 'transit-zero', 'ok', v_transit = 0, 'detail', v_transit),
      jsonb_build_object('name', 'no-pending-admin-transfers', 'ok', v_pending_transfers = 0, 'detail', v_pending_transfers),
      jsonb_build_object('name', 'no-pending-pool-requests', 'ok', v_pending_requests = 0, 'detail', v_pending_requests),
      jsonb_build_object('name', 'active-routes-have-controller', 'ok', cardinality(v_routes) = 0, 'detail', to_jsonb(v_routes)),
      jsonb_build_object('name', 'ledger-clean', 'ok', (v_ledger->>'mismatched')::int = 0 and (v_ledger->>'unbalanced')::int = 0
                           and (v_ledger->>'negativeCustody')::int = 0 and (v_ledger->>'routeScope')::int = 0 and v_overdrawn = 0 and v_conservation = 0,
                         'detail', jsonb_build_object('mismatched', v_ledger->'mismatched', 'unbalanced', v_ledger->'unbalanced', 'negativeCustody', v_ledger->'negativeCustody',
                                                      'routeScope', v_ledger->'routeScope', 'overdrawn', v_overdrawn, 'conservation', v_conservation)));
    return jsonb_build_object('model', adex.company_capital_model(v_company), 'checks', v_checks,
      'ok', not exists (select 1 from jsonb_array_elements(v_checks) c where not (c->>'ok')::boolean),
      'unassignedPools', v_pools);
  end $$;

-- capital_model_transition: la de 0034_route_base.sql.
create or replace function adex.capital_model_transition(p_operation_id uuid, p_target text, p_evidence text, p_backup_reference text, p_company_balance_note text)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_identity uuid := adex.ctx_identity();
    v_from    text;
    v_pre     jsonb := '{}'::jsonb;
    v_failed  text[];
    v_note    text := nullif(btrim(coalesce(p_company_balance_note, '')), '');
    v_backup  text := nullif(btrim(coalesce(p_backup_reference, '')), '');
    v_since   timestamptz;
    v_id      text := gen_random_uuid()::text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if v_company is null or v_actor is null or v_identity is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'the capital model is authorized by the SuperAdmin');
    end if;
    if p_operation_id is null or p_target is null or p_target not in ('admin_pool', 'migrating', 'route_base') then
      perform adex.capital_raise('AX411', 'operation id and a valid target model are required');
    end if;
    if p_evidence is null or length(btrim(p_evidence)) < 10 or length(p_evidence) > 1000 then perform adex.capital_raise('AX411', 'evidence is required (10+ characters)'); end if;
    if exists (select 1 from adex.capital_model_activations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    -- Como una revocación (REVOKE-004): espera a que terminen los comandos en curso de la empresa y
    -- detiene los nuevos hasta el COMMIT; los requisitos se leen con todo lo ya confirmado.
    perform pg_advisory_xact_lock(adex.lock_key('company', v_company));
    select capital_model into v_from from adex.companies where id = v_company for update;
    if v_from = p_target then perform adex.capital_raise('AX411', 'the company already uses that model'); end if;
    if v_from = 'route_base' then perform adex.capital_raise('AX421', 'the route base model cannot be deactivated'); end if;
    if p_target = 'admin_pool' and v_from <> 'migrating' then perform adex.capital_raise('AX411', 'invalid transition'); end if;
    if p_target = 'route_base' then
      if v_backup is null or length(v_backup) > 300 then perform adex.capital_raise('AX411', 'a verified backup reference is required'); end if;
      if v_note is not null and length(v_note) < 10 then perform adex.capital_raise('AX411', 'the company balance note needs 10+ characters'); end if;
      v_pre := adex.capital_model_prerequisites();
      select coalesce(array_agg(c->>'name'), '{}') into v_failed from jsonb_array_elements(v_pre->'checks') c
       -- R74 (0036, RB-D2): la cuenta de la empresa debe estar en cero; `p_company_balance_note` se conserva por
       -- compatibilidad (se guarda) pero ya no exime de ningún requisito.
       where not (c->>'ok')::boolean;
      if cardinality(v_failed) > 0 then
        perform adex.capital_raise('AX425', 'prerequisites not met: ' || array_to_string(v_failed, ', '));
      end if;
      v_since := now();
    end if;
    update adex.companies set capital_model = p_target, route_base_since = v_since, updated_at = now() where id = v_company;
    insert into adex.capital_model_activations (id, company_id, operation_id, from_model, to_model, evidence, backup_reference, company_balance_note,
                                                prerequisites, unassigned_pools, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_id, v_company, p_operation_id, v_from, p_target, btrim(p_evidence), v_backup, case when p_target = 'route_base' then v_note end,
            v_pre, coalesce(v_pre->'unassignedPools', '[]'::jsonb), v_actor, v_identity, 'superadmin', txid_current());
    return jsonb_build_object('activationId', v_id, 'fromModel', v_from, 'model', p_target, 'routeBaseSince', v_since,
      'prerequisites', v_pre, 'unassignedPools', coalesce(v_pre->'unassignedPools', '[]'::jsonb));
  end $$;

-- route_period_figures: la de 0034_route_base.sql.
create or replace function adex.route_period_figures(p_company text, p_route text, p_from date, p_to date) returns jsonb
  language plpgsql stable
  as $$
  declare
    v_workers jsonb;
    v_custody jsonb;
    v_pool    jsonb;
    v_credit  jsonb;
    v_setl    jsonb;
    v_ops     jsonb;
    v_base    jsonb;
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
             coalesce(-sum(amt) filter (where d >= p_from and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0)::bigint disbursements,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_EXPENSE'), 0)::bigint expenses,
             -- R74 (0036, RB-D3): faltantes de cuadre reconocidos por la ruta (salen de la custodia).
             coalesce(sum(amt) filter (where d >= p_from and b = 'DIFFERENCE_CONCILIATION'), 0)::bigint conciliated,
             coalesce(sum(amt) filter (where d >= p_from and b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                     'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'WORKER_EXPENSE',
                                                                     'DIFFERENCE_CONCILIATION')), 0)::bigint other,
             coalesce(sum(amt), 0)::bigint closing
        from legs group by mid
    )
    select coalesce(jsonb_agg(jsonb_build_object('workerId', w.mid, 'name', m.display_name, 'role', m.role,
             'openingMinor', w.opening, 'deliveriesMinor', w.deliveries, 'transfersInMinor', w.t_in, 'transfersOutMinor', w.t_out,
             'partialReturnsMinor', w.partial_returns, 'settlementReturnsMinor', w.settlement_returns, 'collectionsMinor', w.collections,
             'disbursementsMinor', w.disbursements, 'workerExpensesMinor', w.expenses, 'otherMinor', w.other, 'closingMinor', w.closing)
             -- Clave solo cuando hay conciliaciones: los cierres archivados antes de 0036 no cambian.
             || case when w.conciliated <> 0 then jsonb_build_object('conciliatedShortagesMinor', -w.conciliated) else '{}'::jsonb end
             order by m.display_name, w.mid), '[]'::jsonb),
           jsonb_build_object('openingMinor', coalesce(sum(w.opening), 0), 'deliveriesMinor', coalesce(sum(w.deliveries), 0),
             'transfersInMinor', coalesce(sum(w.t_in), 0), 'transfersOutMinor', coalesce(sum(w.t_out), 0),
             'partialReturnsMinor', coalesce(sum(w.partial_returns), 0), 'settlementReturnsMinor', coalesce(sum(w.settlement_returns), 0),
             'collectionsMinor', coalesce(sum(w.collections), 0), 'disbursementsMinor', coalesce(sum(w.disbursements), 0),
             'workerExpensesMinor', coalesce(sum(w.expenses), 0), 'otherMinor', coalesce(sum(w.other), 0), 'closingMinor', coalesce(sum(w.closing), 0))
             || case when coalesce(sum(w.conciliated), 0) <> 0 then jsonb_build_object('conciliatedShortagesMinor', -coalesce(sum(w.conciliated), 0))
                     else '{}'::jsonb end
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
             'disbursedFromPoolMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'partnerContributionsMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'PARTNER_CONTRIBUTION'), 0),
             'surplusHeldMinor', coalesce(sum(amt) filter (where ak = 'suspense'), 0)),
           jsonb_build_object(
             'principalDisbursedMinor', coalesce(sum(amt) filter (where ak = 'portfolio' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'principalCollectedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b in ('COLLECTION', 'PRINCIPAL_RECLASSIFICATION')), 0),
             'principalReclassifiedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b = 'PRINCIPAL_RECLASSIFICATION'), 0),
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

    -- R74 Base por Ruta (0034): Base de la ruta (route_base) y su contrapartida (route_funding).
    with legs as (
      select e.amount_minor amt, a.kind ak, o.entry_date d, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and a.kind in ('route_base', 'route_funding') and a.route_id = p_route and o.entry_date <= p_to
    )
    select jsonb_build_object(
             'openingMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d < p_from), 0),
             'injectionsMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_BASE_INJECTION'), 0),
             'withdrawalsMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_BASE_WITHDRAWAL'), 0),
             'transfersInMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_TRANSFER' and amt > 0), 0),
             'transfersOutMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_TRANSFER' and amt < 0), 0),
             'unassignedAssignedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'LEGACY_POOL_TO_ROUTE'), 0),
             'deliveredToWorkersMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'WORKER_DELIVERY'), 0),
             'returnsReceivedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b in ('WORKER_RETURN', 'SETTLEMENT_RETURN')), 0),
             'reassignmentsNetMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_REASSIGNMENT'), 0),
             'collectionsReceivedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'COLLECTION'), 0),
             'disbursedMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'routeExpensesMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_EXPENSE'), 0),
             -- R74 (0036, RB-D3): diferencias de actas y sobrantes conciliados contra la Base (con signo).
             'conciliatedDifferencesMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'DIFFERENCE_CONCILIATION'), 0),
             'otherMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL',
                              'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE', 'WORKER_DELIVERY', 'WORKER_RETURN', 'SETTLEMENT_RETURN', 'ROUTE_REASSIGNMENT', 'COLLECTION',
                              'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'ROUTE_EXPENSE', 'DIFFERENCE_CONCILIATION')), 0),
             'closingMinor', coalesce(sum(amt) filter (where ak = 'route_base'), 0),
             'contributionsNetMinor', coalesce(-sum(amt) filter (where ak = 'route_funding'), 0))
      into v_base from legs;

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops, 'base', v_base);
  end $$;

-- custody_settlement_reopen: la de 0034_route_base.sql.
create or replace function adex.custody_settlement_reopen(p_operation_id uuid, p_settlement text, p_reason text) returns jsonb
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
    v_carried bigint;
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
    -- Reabrir es CORREGIR: solo el responsable de capital de la ruta (R74: no el SuperAdmin).
    if x.actor is distinct from v_ctrl then
      perform adex.capital_raise('AX402', 'only the route capital controller can reopen');
    end if;
    if adex.same_person(x.company, x.actor, s.worker_membership_id) then perform adex.capital_raise('AX801', 'nobody reopens their own settlement'); end if;
    -- D7: hoy abierto y el día del cuadre en un periodo abierto (lo cerrado no se reabre).
    if adex.capital_period_closed(x.company, s.route_id, x.today) or adex.capital_period_closed(x.company, s.route_id, s.business_date) then
      perform adex.capital_raise('AX407', 'the period of the settlement is closed');
    end if;

    -- R74 Base por Ruta (0034): con `route_base` el efectivo devuelto sale de la Base de la ruta.
    v_pool := adex.route_cash_redirect(x.company, adex.capital_account_for(x.company, 'admin', s.receiver_admin_membership_id, null), s.route_id);
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
    -- R74 (0036, RB-D3): la conciliación de sus diferencias es definitiva y se apoya en este cuadre.
    if exists (select 1 from adex.difference_conciliations d where d.company_id = x.company and d.settlement_id = s.id) then
      perform adex.capital_raise('AX806', 'the settlement has conciliated differences: it cannot be reopened');
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
    -- El arrastre vuelve al que había antes de este cuadre (R74, 0036: neto de los faltantes que la ruta reconoció
    -- sobre el cuadre anterior).
    v_carried := s.opening_carried_minor - coalesce((select sum(d.amount_minor) from adex.difference_conciliations d
                                                     where d.company_id = x.company and d.settlement_id = s.previous_settlement_id
                                                       and d.source_kind = 'settlement_shortage' and d.resolution = 'route_shortage'), 0);
    update adex.capital_accounts set carried_minor = v_carried, version = version + 1, updated_at = now()
     where company_id = x.company and id = s.custody_account_id;
    update adex.custody_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = s.id;
    return jsonb_build_object('settlementId', s.id, 'routeId', s.route_id, 'workerId', s.worker_membership_id,
      'returnedToCustodyMinor', s.returned_to_pool_minor, 'surplusReleasedMinor', s.surplus_minor, 'carriedMinor', v_carried,
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

-- expense_correctable: la de 0035_general_expenses_funding.sql.
create or replace function adex.expense_correctable(x adex.money_ctx, p_expense text, p_refund boolean) returns adex.expense_fix
  language plpgsql
  as $$
  declare e adex.expenses; o adex.capital_operations; v_ctrl text; r adex.expense_fix;
  begin
    if not adex.ctx_can('expense.correct') then perform adex.capital_raise('42501', 'no expense correction authority'); end if;
    select * into e from adex.expenses where company_id = x.company and id = p_expense;
    if not found or (e.route_id is not null and not adex.ctx_route_allowed(e.route_id)) then perform adex.capital_raise('AX412', 'expense not found'); end if;
    if e.route_id is not null then perform 1 from adex.routes where company_id = x.company and id = e.route_id for share; end if;
    select * into e from adex.expenses where company_id = x.company and id = p_expense for update;
    if e.ledger_operation_id is null then perform adex.capital_raise('AX706', 'expense without ledger entry is not corrected here (D9)'); end if;
    if e.reverses_id is not null or e.refunds_expense_id is not null then perform adex.capital_raise('AX404', 'a correction cannot be corrected'); end if;
    if e.reversal_id is not null then perform adex.capital_raise('AX405', 'expense already reversed'); end if;
    select * into o from adex.capital_operations where company_id = x.company and id = e.ledger_operation_id;
    -- R74 (0035, D74-O4F): gasto general con aportes de rutas o dinero propio: lo anula SOLO el Administrador
    -- responsable que lo registró (socio de confianza, sin aprobación); sin reintegros parciales.
    if e.funding in ('routes', 'own_money') then
      if p_refund then perform adex.capital_raise('AX713', 'general expenses funded by routes or own money are corrected only by reversal'); end if;
      if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator reverses general expenses'); end if;
      if e.funding = 'own_money' then
        -- Sin rutas afectadas: la obligación es con ese Administrador; solo él la anula (AX432 si ya se reembolsó).
        if e.responsible_admin_membership_id is distinct from x.actor then
          perform adex.capital_raise('AX402', 'only the administrator the company owes reverses an expense paid with own money');
        end if;
      else
        -- R74 (0036, RB-D7): el dinero vuelve a la Base de cada ruta aportante: lo anula el responsable VIGENTE de
        -- TODAS ellas (aunque no lo registrara); rutas de distintos responsables → AX434 (nunca una anulación parcial).
        perform 1 from adex.routes where company_id = x.company
           and id in (select g.route_id from adex.general_funding_contributions g where g.company_id = x.company and g.expense_id = e.id)
         order by id for share;
        perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                    where g.company_id = x.company and g.expense_id = e.id order by g.route_id), x.actor);
      end if;
    elsif e.scope is distinct from 'empresa' then
      -- F5-D02 (aprobada 2026-10-17): anulación de gastos de trabajador y de ruta.
      if p_refund then perform adex.capital_raise('AX713', 'only pool expenses have refunds'); end if;
      -- Autoridad `correct`: el Administrador responsable de capital de la ruta (R74: no el SuperAdmin).
      v_ctrl := adex.route_valid_controller(x.company, e.route_id);
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if x.actor is distinct from v_ctrl then
        perform adex.capital_raise('AX402', 'only the route capital controller can reverse');
      end if;
      -- Control independiente: quien anula no es la PERSONA que registró (ni con otra membresía).
      if adex.same_person(x.company, x.actor, e.registered_by_membership_id) then
        perform adex.capital_raise('AX717', 'the person who registered the expense cannot reverse it');
      end if;
      -- D7: la anulación se asienta hoy, que debe estar abierto; si la semana del gasto está
      -- cerrada, es un ajuste en el periodo abierto y exige la autoridad de aprobar ajustes.
      if adex.capital_period_closed(x.company, e.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      if adex.capital_period_closed(x.company, e.route_id, e.expense_date)
         and not adex.ctx_can('payment.approveAdjustment') then
        perform adex.capital_raise('42501', 'closed period needs adjustment authority');
      end if;
    -- D12 (CLEAN `canCorrectPoolExpense`): el Administrador, su bolsa; el SuperAdmin, cualquiera.
    elsif not (x.role = 'superadmin' or (x.role = 'admin' and e.funding = 'admin' and e.funding_admin_membership_id = x.actor)) then
      perform adex.capital_raise('AX402', 'you cannot correct expenses of that pool');
    end if;
    select e.id as id, e.amount_minor as amount, e.route_id as route, e.scope as scope, o.id as op, o.kind as kind,
           o.admin_membership_id as admin, o.worker_membership_id as worker,
           (select account_id from adex.capital_entries where company_id = x.company and operation_id = o.id and amount_minor < 0) as payer,
           (select account_id from adex.capital_entries where company_id = x.company and operation_id = o.id and amount_minor > 0) as expacc,
           coalesce((select -sum(amount_minor) from adex.expenses where company_id = x.company and refunds_expense_id = e.id), 0) as refunded
      into r;
    -- R74 Base por Ruta (0034): un gasto de ruta pagado por la bolsa antes del corte se corrige contra la Base.
    if r.scope is distinct from 'empresa' then r.payer := adex.route_cash_redirect(x.company, r.payer, r.route); end if;
    return r;
  end $$;

-- admin_reimbursement_reverse: la de 0035_general_expenses_funding.sql.
create or replace function adex.admin_reimbursement_reverse(p_operation_id uuid, p_reimbursement text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    r       adex.admin_reimbursements;
    v_payable text;
    v_src   text;
    v_accts text[] := '{}';
    v_op    text;
    v_first text;
    v_n     int := 0;
    v_ops   jsonb := '[]'::jsonb;
    c       record;
    v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only the administrator who paid reverses a reimbursement'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select * into r from adex.admin_reimbursements where company_id = x.company and id = p_reimbursement for update;
    if not found then perform adex.capital_raise('AX412', 'reimbursement not found'); end if;
    if r.reversed_at is not null then perform adex.capital_raise('AX405', 'reimbursement already reversed'); end if;
    -- R74 (0036, RB-D7): desde rutas, el responsable VIGENTE de TODAS las rutas aportantes (el dinero vuelve a cada
    -- Base y la obligación vuelve a quedar pendiente); desde una bolsa (`admin_pool`), quien pagó (vuelve a su bolsa).
    if r.source = 'admin_pool' then
      if r.payer_membership_id is distinct from x.actor then perform adex.capital_raise('AX402', 'only the administrator who paid reverses a reimbursement'); end if;
    else
      perform 1 from adex.routes where company_id = x.company
         and id in (select g.route_id from adex.general_funding_contributions g where g.company_id = x.company and g.reimbursement_id = r.id)
       order by id for share;
      perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                  where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id), x.actor);
    end if;
    v_payable := adex.capital_account_for(x.company, 'admin_payable', r.admin_membership_id, null);
    for c in select g.route_id from adex.general_funding_contributions g
              where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id loop
      if c.route_id is null then
        v_accts := v_accts || adex.capital_account_for(x.company, 'admin', x.actor, null);
      else
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, 'reembolso') then
          perform adex.capital_raise('AX430', 'the money returns to each route base: you must still be the capital controller of every contributing route');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end if;
    end loop;
    perform adex.capital_lock_accounts(x.company, v_accts || v_payable);
    for c in select g.route_id, g.amount_minor, g.operation_id from adex.general_funding_contributions g
              where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id loop
      v_n := v_n + 1;
      v_op := gen_random_uuid()::text;
      if v_n = 1 then v_first := v_op; end if;
      v_src := case when c.route_id is null then adex.capital_account_for(x.company, 'admin', x.actor, null)
                    else adex.capital_account_for(x.company, 'route_base', null, c.route_id) end;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           counterpart_membership_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id, x.actor,
              r.admin_membership_id, c.operation_id, 'ADMIN_REIMBURSEMENT', btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_payable, v_src], array[-c.amount_minor, c.amount_minor]);
      v_ops := v_ops || to_jsonb(v_op);
    end loop;
    update adex.admin_reimbursements set reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = btrim(p_reason),
           reversal_operation_id = p_operation_id
     where company_id = x.company and id = r.id;
    return jsonb_build_object('reimbursementId', r.id, 'adminId', r.admin_membership_id, 'amountMinor', r.amount_minor, 'operationIds', v_ops,
                              'operationId', v_first, 'pendingAfterMinor', -(select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable));
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'admin_reimbursements_reversal_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'reimbursement already reversed'); end if;
      raise;
  end $$;

-- route_panel: la de 0035_general_expenses_funding.sql.
create or replace function adex.route_panel(p_from date, p_to date) returns jsonb
  language plpgsql stable set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_model   text;
    v_since   timestamptz;
    v_routes  jsonb := '[]'::jsonb;
    r record;
    f jsonb;
    c record;
    v_base bigint; v_funding bigint; v_portf bigint; v_surplus bigint; v_outstanding bigint; v_approved bigint;
    v_exp_op bigint; v_exp_dur bigint; v_exp_other bigint; v_interest bigint; v_collected bigint; v_disbursed bigint;
    v_result bigint; v_flow bigint; v_needs bigint; v_alerts text[]; v_handover jsonb;
    t_base bigint := 0; t_custody bigint := 0; t_deliverable bigint := 0; t_portf bigint := 0; t_result bigint := 0; t_flow bigint := 0;
    v_general jsonb; v_pools jsonb;
    v_gf jsonb; v_admin_general jsonb; v_company_general jsonb; v_payables jsonb; v_reimb jsonb; v_gen_op bigint; v_gen_dur bigint;
    v_dif jsonb; t_dif jsonb := '{}'::jsonb; k text;
  begin
    if v_company is null or adex.ctx_role() is null or not adex.ctx_can('cashbox.viewRoute') then
      perform adex.capital_raise('42501', 'no route cash authority');
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 370 then perform adex.capital_raise('AX411', 'invalid period'); end if;
    select capital_model, route_base_since into v_model, v_since from adex.companies where id = v_company;

    for r in select ro.id, ro.name, ro.code, ro.status, ro.handover_state, ro.capital_controller_membership_id ctrl, m.display_name ctrl_name,
                    (ro.capital_controller_membership_id is not null and coalesce(adex.route_controller_valid(v_company, ro.id), false)) ctrl_valid
               from adex.routes ro left join adex.memberships m on m.company_id = ro.company_id and m.id = ro.capital_controller_membership_id
              where ro.company_id = v_company order by ro.name, ro.id loop
      f := adex.route_period_figures(v_company, r.id, p_from, p_to);
      select coalesce(sum(balance_minor), 0) gross, coalesce(sum(least(balance_minor, 0)), 0) negative,
             coalesce(sum(greatest(balance_minor - carried_minor, 0)), 0) deliverable, coalesce(sum(carried_minor), 0) carried, count(*) n
        into c from adex.capital_accounts where company_id = v_company and route_id = r.id and kind = 'custody';
      select coalesce(sum(balance_minor) filter (where kind = 'route_base'), 0), coalesce(-sum(balance_minor) filter (where kind = 'route_funding'), 0),
             coalesce(sum(balance_minor) filter (where kind = 'portfolio'), 0), coalesce(sum(balance_minor) filter (where kind = 'suspense'), 0)
        into v_base, v_funding, v_portf, v_surplus
        from adex.capital_accounts where company_id = v_company and route_id = r.id and kind in ('route_base', 'route_funding', 'portfolio', 'suspense');
      select coalesce(sum(balance_minor), 0) into v_outstanding from adex.sales
       where company_id = v_company and route_id = r.id and status = 'activa' and ledger_operation_id is not null;
      select coalesce(sum(amount_minor), 0) into v_approved from adex.sale_requests where company_id = v_company and route_id = r.id and status = 'approved';
      select coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0),
             coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0),
             coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0)
        into v_exp_op, v_exp_dur, v_exp_other
        from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
       where x.company_id = v_company and x.route_id = r.id and x.ledger_operation_id is not null and x.expense_date between p_from and p_to;
      v_interest := coalesce((f #>> '{credit,interestCollectedMinor}')::bigint, 0);
      v_collected := coalesce((f #>> '{credit,principalCollectedMinor}')::bigint, 0) + v_interest;
      v_disbursed := coalesce((f #>> '{credit,principalDisbursedMinor}')::bigint, 0);
      v_result := v_interest - v_exp_op - v_exp_other;
      v_flow := v_collected - v_disbursed - v_exp_op - v_exp_other - v_exp_dur;
      v_needs := case when v_model = 'route_base' then greatest(0, v_approved - (v_base + c.deliverable)) end;
      select to_jsonb(h) - 'company_id' into v_handover from (
        select id, status, from_membership_id, to_membership_id, base_at_start_minor, started_at, expected_base_minor, counted_minor, difference_minor, confirmed_at
          from adex.route_handover_records where company_id = v_company and route_id = r.id order by started_at desc, id limit 1) h;
      -- R74 (0035): salidas de la Base hacia gastos generales y reembolsos del periodo (netas de anulaciones).
      -- Son financiación de gastos ajenos a la ruta: NO entran en su resultado ni en su flujo operativo.
      select jsonb_build_object(
               'generalExpenseContributionsMinor', coalesce(-sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'GENERAL_EXPENSE_CONTRIBUTION'), 0),
               'adminReimbursementsMinor', coalesce(-sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'ADMIN_REIMBURSEMENT'), 0))
        into v_gf
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = v_company and a.kind = 'route_base' and a.route_id = r.id
         and coalesce(o.reverses_kind, o.kind) in ('GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT') and o.entry_date between p_from and p_to;
      -- R74 (0036, RB-D3): diferencias de la ruta (pendientes y conciliadas). Nunca efectivo ni resultado.
      v_dif := adex.route_difference_summary(r.id);
      for k in select jsonb_object_keys(v_dif) loop
        if jsonb_typeof(v_dif -> k) = 'number' then t_dif := t_dif || jsonb_build_object(k, coalesce((t_dif ->> k)::bigint, 0) + (v_dif ->> k)::bigint); end if;
      end loop;
      v_alerts := array_remove(array[
        case when not r.ctrl_valid then 'NO_VALID_CONTROLLER' end,
        case when r.handover_state = 'en_entrega' then 'ROUTE_IN_HANDOVER' end,
        -- R74 (0036): una diferencia de acta conciliada deja de alertar.
        case when (v_handover->>'status') = 'confirmada' and coalesce((v_handover->>'difference_minor')::bigint, 0) <> 0
                  and not exists (select 1 from adex.difference_conciliations d where d.company_id = v_company and d.handover_id = (v_handover->>'id'))
             then 'HANDOVER_DIFFERENCE' end,
        case when coalesce((v_dif->>'pendingCount')::int, 0) > 0 then 'PENDING_DIFFERENCES' end,
        case when c.negative < 0 then 'NEGATIVE_CUSTODY' end,
        case when c.carried > 0 then 'CARRIED_SHORTAGE' end,
        case when v_surplus > 0 then 'SURPLUS_IN_CONTROL' end,
        case when v_result < 0 then 'NEGATIVE_OPERATING_RESULT' end,
        case when v_flow < 0 and v_result >= 0 then 'NEGATIVE_FLOW_GROWTH' end,
        case when coalesce(v_needs, 0) > 0 then 'INSUFFICIENT_LIQUIDITY' end], null);
      v_routes := v_routes || jsonb_build_object(
        'routeId', r.id, 'name', r.name, 'code', r.code, 'status', r.status, 'handoverState', r.handover_state, 'lastHandover', v_handover,
        'controller', jsonb_build_object('id', r.ctrl, 'name', r.ctrl_name, 'valid', r.ctrl_valid),
        'baseMinor', v_base, 'contributionsNetMinor', v_funding,
        'custody', jsonb_build_object('grossMinor', c.gross, 'negativeMinor', c.negative, 'deliverableMinor', c.deliverable, 'carriedShortageMinor', c.carried, 'positions', c.n),
        'cashMinor', v_base + c.gross, 'surplusInControlMinor', v_surplus,
        'portfolio', jsonb_build_object('principalPlacedMinor', v_portf, 'outstandingWithInterestMinor', v_outstanding),
        'approvedNotDisbursedMinor', v_approved,
        'period', jsonb_build_object('collectionsMinor', v_collected, 'interestCollectedMinor', v_interest, 'principalDisbursedMinor', v_disbursed,
                    'expenses', jsonb_build_object('operativoMinor', v_exp_op, 'bienDuraderoMinor', v_exp_dur, 'otroMinor', v_exp_other),
                    'base', f -> 'base'),
        'operatingResultMinor', v_result, 'operatingFlowMinor', v_flow, 'capitalNeedMinor', v_needs,
        'states', jsonb_build_object('negativeOperatingResult', v_result < 0, 'negativeFlowFromGrowth', v_flow < 0 and v_result >= 0,
                    'insufficientLiquidity', case when v_needs is null then null else v_needs > 0 end),
        'generalFunding', v_gf,
        'differences', v_dif,
        'alerts', to_jsonb(v_alerts));
      t_base := t_base + v_base; t_custody := t_custody + c.gross; t_deliverable := t_deliverable + c.deliverable; t_portf := t_portf + v_portf;
      t_result := t_result + v_result; t_flow := t_flow + v_flow;
    end loop;

    -- Gastos generales (alcance empresa) del periodo, aparte de las rutas (O8): por fuente y naturaleza.
    select jsonb_build_object(
             'administratorMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'admin'), 0),
             'companyMinor', coalesce(sum(x.amount_minor) filter (where x.funding is distinct from 'admin'), 0),
             'operativoMinor', coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0),
             'bienDuraderoMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0),
             'otroMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0))
      into v_general
      from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
     where x.company_id = v_company and x.scope = 'empresa' and x.ledger_operation_id is not null and x.expense_date between p_from and p_to;
    -- Bolsas visibles: con `route_base` son saldo «sin asignar» (O3); con `admin_pool`, la bolsa operativa.
    select coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'balanceMinor', a.balance_minor)
                    order by m.display_name, a.membership_id), '[]'::jsonb)
      into v_pools
      from adex.capital_accounts a left join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin' and a.balance_minor <> 0;

    -- R74 (0035, O8): gastos generales del Administrador (alcance `administrador`) y de la empresa, APARTE del
    -- resultado de las rutas, por naturaleza y por fuente. Sin prorrateo.
    select coalesce(jsonb_agg(jsonb_build_object('adminId', g.admin, 'name', m.display_name, 'totalMinor', g.total, 'operativoMinor', g.op,
                    'bienDuraderoMinor', g.dur, 'otroMinor', g.oth, 'routesFundedMinor', g.routes, 'ownMoneyMinor', g.own)
                    order by m.display_name, g.admin), '[]'::jsonb)
      into v_admin_general
      from (select x.responsible_admin_membership_id admin, sum(x.amount_minor) total,
                   coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0) op,
                   coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0) dur,
                   coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0) oth,
                   coalesce(sum(x.amount_minor) filter (where x.funding = 'routes'), 0) routes,
                   coalesce(sum(x.amount_minor) filter (where x.funding = 'own_money'), 0) own
              from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
             where x.company_id = v_company and x.scope = 'administrador' and x.ledger_operation_id is not null and x.expense_date between p_from and p_to
             group by x.responsible_admin_membership_id) g
      left join adex.memberships m on m.company_id = v_company and m.id = g.admin;
    select jsonb_build_object(
             'totalMinor', coalesce(sum(x.amount_minor), 0),
             'operativoMinor', coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0),
             'bienDuraderoMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0),
             'otroMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0),
             'byFunding', jsonb_build_object(
                 'routesMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'routes'), 0),
                 'ownMoneyMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'own_money'), 0),
                 'adminPoolMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'admin'), 0),
                 'companyAccountMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'empresa'), 0)))
      into v_company_general
      from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
     where x.company_id = v_company and x.scope = 'empresa' and x.ledger_operation_id is not null and x.expense_date between p_from and p_to;
    -- Reembolsos pendientes a Administradores (Σ admin_payable, saldo actual): obligación de la empresa, NUNCA efectivo
    -- (no entra en Base, custodias, `cashMinor` ni ningún total de caja).
    select jsonb_build_object('totalMinor', coalesce(sum(-a.balance_minor), 0), 'isCash', false,
             'admins', coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'pendingMinor', -a.balance_minor)
                         order by m.display_name, a.membership_id), '[]'::jsonb))
      into v_payables
      from adex.capital_accounts a left join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin_payable' and a.balance_minor <> 0;
    -- Reembolsos pagados en el periodo (netos de anulaciones), por fuente.
    select jsonb_build_object(
             'totalMinor', coalesce(sum(case when o.kind = 'REVERSAL' then -o.amount_minor else o.amount_minor end), 0),
             'fromRoutesMinor', coalesce(sum(case when o.kind = 'REVERSAL' then -o.amount_minor else o.amount_minor end) filter (where o.route_id is not null), 0),
             'fromAdminPoolMinor', coalesce(sum(case when o.kind = 'REVERSAL' then -o.amount_minor else o.amount_minor end) filter (where o.route_id is null), 0))
      into v_reimb
      from adex.capital_operations o
     where o.company_id = v_company and coalesce(o.reverses_kind, o.kind) = 'ADMIN_REIMBURSEMENT' and o.entry_date between p_from and p_to;
    v_gen_op := coalesce((v_company_general->>'operativoMinor')::bigint, 0) + coalesce((v_company_general->>'otroMinor')::bigint, 0)
              + coalesce((select sum((g->>'operativoMinor')::bigint + (g->>'otroMinor')::bigint) from jsonb_array_elements(v_admin_general) g), 0);
    v_gen_dur := coalesce((v_company_general->>'bienDuraderoMinor')::bigint, 0)
              + coalesce((select sum((g->>'bienDuraderoMinor')::bigint) from jsonb_array_elements(v_admin_general) g), 0);

    return jsonb_build_object('model', v_model, 'routeBaseSince', v_since, 'from', p_from, 'to', p_to, 'routes', v_routes,
      'general', jsonb_build_object('expenses', v_general,
                   (case when v_model = 'route_base' then 'unassignedPools' else 'adminPools' end), v_pools,
                   'companyAccountMinor', (select balance_minor from adex.capital_accounts where company_id = v_company and kind = 'company'),
                   'administratorGeneral', v_admin_general, 'companyGeneral', v_company_general,
                   'pendingAdminReimbursements', v_payables, 'reimbursementsPaid', v_reimb),
      'totals', jsonb_build_object('baseMinor', t_base, 'custodyMinor', t_custody, 'deliverableCustodyMinor', t_deliverable, 'cashMinor', t_base + t_custody,
                  'portfolioPrincipalMinor', t_portf, 'operatingResultMinor', t_result, 'operatingFlowMinor', t_flow),
      -- Consolidado (O8): resultado operativo de las rutas y, APARTE, los gastos generales; los bienes duraderos y los
      -- reembolsos pendientes se informan sin restarse como efectivo.
      'consolidated', jsonb_build_object('routesOperatingResultMinor', t_result, 'generalOperatingExpensesMinor', v_gen_op,
                  'generalDurableGoodsMinor', v_gen_dur, 'resultAfterGeneralExpensesMinor', t_result - v_gen_op,
                  'pendingAdminReimbursementsMinor', coalesce((v_payables->>'totalMinor')::bigint, 0)),
      -- R74 (0036, RB-D3): diferencias consolidadas (pendientes y conciliadas), aparte del efectivo y del resultado.
      'differences', t_dif || jsonb_build_object('isCash', false));
  end $$;

-- ============================================================
-- 4. Conciliación de diferencias (RB-D3)
-- ============================================================

-- Diferencias visibles (Administrador y Supervisor: rutas de su alcance; SuperAdmin: todas). Solo lectura.
-- p_route NULL = todas las del alcance. Cada fila dice qué resoluciones admite.
create function adex.route_differences(p_route text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active()
       or not adex.ctx_is(array['superadmin', 'admin', 'supervisor']) then
      perform adex.capital_raise('42501', 'no route cash authority');
    end if;
    if p_route is not null and (not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = v_company and id = p_route)) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'sourceKind', i.source_kind, 'sourceId', i.source_id, 'routeId', i.route_id, 'routeName', ro.name,
               'workerId', i.worker_id, 'workerName', wm.display_name, 'holderId', i.holder_id, 'holderName', hm.display_name,
               'kind', i.kind, 'expectedMinor', i.expected_minor, 'countedMinor', i.counted_minor, 'differenceMinor', i.difference_minor,
               'pendingMinor', i.pending_minor, 'workerOwedMinor', i.worker_owed_minor, 'carriedMinor', i.carried_minor,
               'pending', i.pending_minor > 0, 'occurredAt', i.occurred_at, 'businessDate', i.business_date,
               'controllerId', adex.route_valid_controller(v_company, i.route_id),
               'allowedResolutions', to_jsonb(adex.difference_resolutions(i.source_kind, i.kind, i.pending_minor)))
             order by i.occurred_at, i.source_kind, i.source_id)
        from adex.difference_items_internal(v_company, p_route) i
        join adex.routes ro on ro.company_id = v_company and ro.id = i.route_id
        left join adex.memberships wm on wm.company_id = v_company and wm.id = i.worker_id
        left join adex.memberships hm on hm.company_id = v_company and hm.id = i.holder_id
       where adex.ctx_route_allowed(i.route_id)), '[]'::jsonb);
  end $$;
revoke all on function adex.route_differences(text) from public;
grant execute on function adex.route_differences(text) to adex_api;

-- Indicadores de diferencias de UNA ruta (pendientes y conciliadas). Fuera del alcance: ceros.
-- `conciliatedNetMinor` = saldo de route_difference (+ faltante conciliado / − sobrante conciliado). Nunca efectivo.
create function adex.route_difference_summary(p_route text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company(); v jsonb; c jsonb;
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_route_allowed(p_route) then
      v := jsonb_build_object('pendingCount', 0, 'pendingShortageMinor', 0, 'pendingSurplusMinor', 0, 'workerOwedMinor', 0);
    else
      select jsonb_build_object('pendingCount', count(*) filter (where i.pending_minor > 0),
               'pendingShortageMinor', coalesce(sum(i.pending_minor) filter (where i.kind = 'faltante'), 0),
               'pendingSurplusMinor', coalesce(sum(i.pending_minor) filter (where i.kind = 'sobrante'), 0),
               'workerOwedMinor', coalesce(sum(i.worker_owed_minor), 0))
        into v from adex.difference_items_internal(v_company, p_route) i;
    end if;
    select jsonb_build_object(
             'conciliatedCount', count(d.id),
             'conciliatedShortageMinor', coalesce(sum(d.amount_minor) filter (where d.resolution = 'route_shortage'), 0),
             'workerOwesDecidedMinor', coalesce(sum(d.amount_minor) filter (where d.resolution = 'worker_owes'), 0),
             'surplusToBaseMinor', coalesce(sum(d.amount_minor) filter (where d.resolution = 'surplus_to_base'), 0),
             'surplusReturnedMinor', coalesce(sum(d.amount_minor) filter (where d.resolution = 'surplus_returned'), 0),
             'conciliatedNetMinor', coalesce((select a.balance_minor from adex.capital_accounts a
                                               where a.company_id = v_company and a.kind = 'route_difference' and a.route_id = p_route), 0),
             'isCash', false)
      into c
      from adex.difference_conciliations d
     where d.company_id = v_company and d.route_id = p_route and adex.ctx_route_allowed(p_route);
    return v || c;
  end $$;
revoke all on function adex.route_difference_summary(text) from public;
grant execute on function adex.route_difference_summary(text) to adex_api;

-- Vista previa (no escribe): cifras, importe a resolver, patas que se escribirían y lo que impediría resolver.
create function adex.difference_preview(p_source_kind text, p_source_id text, p_resolution text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_route   text;
    v_model   text;
    v_ctrl    text;
    i         record;
    v_allowed text[];
    v_legs    jsonb := '[]'::jsonb;
    v_block   text[] := '{}';
    v_amounts bigint[];
    v_cash    text;
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active()
       or not adex.ctx_is(array['superadmin', 'admin', 'supervisor']) then
      perform adex.capital_raise('42501', 'no route cash authority');
    end if;
    if p_source_kind is null or p_source_kind not in ('handover', 'settlement_shortage', 'settlement_surplus') or p_source_id is null then
      perform adex.capital_raise('AX411', 'sourceKind and sourceId are required');
    end if;
    if p_source_kind = 'handover' then select route_id into v_route from adex.route_handover_records where company_id = v_company and id = p_source_id;
    else select route_id into v_route from adex.custody_settlements where company_id = v_company and id = p_source_id; end if;
    if v_route is null or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'difference not found'); end if;
    select * into i from adex.difference_items_internal(v_company, v_route) d where d.source_kind = p_source_kind and d.source_id = p_source_id;
    if not found then perform adex.capital_raise('AX435', 'the difference is not pending (already conciliated or superseded)'); end if;
    v_allowed := adex.difference_resolutions(i.source_kind, i.kind, i.pending_minor);
    if p_resolution is not null and not p_resolution = any(v_allowed) then
      perform adex.capital_raise('AX436', 'that resolution does not apply to this difference');
    end if;
    v_model := adex.company_capital_model(v_company);
    v_ctrl := adex.route_valid_controller(v_company, v_route);
    if adex.ctx_role() is distinct from 'admin' then v_block := v_block || 'ONLY_ADMINISTRATOR'::text; end if;
    if v_ctrl is null then v_block := v_block || 'NO_VALID_CONTROLLER'::text;
    elsif v_ctrl is distinct from v_actor then v_block := v_block || 'NOT_ROUTE_CONTROLLER'::text; end if;
    if adex.capital_period_closed(v_company, v_route, adex.business_today(v_company)) then v_block := v_block || 'PERIOD_CLOSED'::text; end if;
    if i.worker_id is not null and adex.same_person(v_company, v_actor, i.worker_id) then v_block := v_block || 'OWN_CASH'::text; end if;
    if v_model = 'route_base' and adex.route_in_handover(v_company, v_route) and (i.source_kind = 'handover' or p_resolution = 'surplus_to_base') then
      v_block := v_block || 'ROUTE_IN_HANDOVER'::text;
    end if;
    if v_model = 'migrating' and p_resolution = 'surplus_to_base' and i.source_kind = 'settlement_surplus' then v_block := v_block || 'CAPITAL_MIGRATION_IN_PROGRESS'::text; end if;
    v_amounts := case when p_resolution = 'route_shortage' and i.source_kind = 'settlement_shortage'
                        then array_remove(array[nullif(i.pending_minor, 0), case when i.worker_owed_minor > 0 then i.pending_minor + i.worker_owed_minor end], null)
                      else array[i.pending_minor] end;
    v_cash := case when v_model = 'route_base' then 'route_base' else 'admin' end;
    if p_resolution is not null then
      v_legs := case
        when i.source_kind = 'handover' and p_resolution = 'route_shortage' then
          jsonb_build_array(jsonb_build_object('kind', 'route_base', 'routeId', v_route, 'sign', -1), jsonb_build_object('kind', 'route_difference', 'routeId', v_route, 'sign', 1))
        when i.source_kind = 'handover' and p_resolution = 'surplus_to_base' then
          jsonb_build_array(jsonb_build_object('kind', 'route_difference', 'routeId', v_route, 'sign', -1), jsonb_build_object('kind', 'route_base', 'routeId', v_route, 'sign', 1))
        when i.source_kind = 'settlement_shortage' and p_resolution = 'route_shortage' then
          jsonb_build_array(jsonb_build_object('kind', 'custody', 'routeId', v_route, 'membershipId', i.worker_id, 'sign', -1),
                            jsonb_build_object('kind', 'route_difference', 'routeId', v_route, 'sign', 1))
        when i.source_kind = 'settlement_surplus' and p_resolution = 'surplus_to_base' then
          jsonb_build_array(jsonb_build_object('kind', 'suspense', 'routeId', v_route, 'membershipId', i.holder_id, 'sign', -1),
                            jsonb_build_object('kind', v_cash, 'routeId', case when v_cash = 'route_base' then v_route end,
                                               'membershipId', case when v_cash = 'admin' then v_ctrl end, 'sign', 1),
                            jsonb_build_object('kind', 'unidentified', 'routeId', v_route, 'sign', 1),
                            jsonb_build_object('kind', 'route_difference', 'routeId', v_route, 'sign', -1))
        when i.source_kind = 'settlement_surplus' and p_resolution = 'surplus_returned' then
          jsonb_build_array(jsonb_build_object('kind', 'suspense', 'routeId', v_route, 'membershipId', i.holder_id, 'sign', -1),
                            jsonb_build_object('kind', 'unidentified', 'routeId', v_route, 'sign', 1))
        else '[]'::jsonb end;
    end if;
    return jsonb_build_object(
      'sourceKind', i.source_kind, 'sourceId', i.source_id, 'routeId', v_route, 'workerId', i.worker_id, 'holderId', i.holder_id, 'kind', i.kind,
      'expectedMinor', i.expected_minor, 'countedMinor', i.counted_minor, 'differenceMinor', i.difference_minor,
      'pendingMinor', i.pending_minor, 'workerOwedMinor', i.worker_owed_minor, 'carriedMinor', i.carried_minor,
      'allowedResolutions', to_jsonb(v_allowed), 'resolution', p_resolution, 'allowedAmountsMinor', to_jsonb(v_amounts),
      'amountMinor', v_amounts[1], 'capitalModel', v_model, 'controllerId', v_ctrl, 'legs', v_legs, 'movesMoney', jsonb_array_length(v_legs) > 0,
      'canResolve', cardinality(v_block) = 0, 'blockers', to_jsonb(v_block));
  end $$;
revoke all on function adex.difference_preview(text, text, text) from public;
grant execute on function adex.difference_preview(text, text, text) to adex_api;

-- Resolución por el Administrador responsable de capital VÁLIDO de la ruta (RB-D3). Idempotente por
-- `p_operation_id` (AX409 al repetirlo; la API devuelve la misma respuesta). Bloqueos: ruta (compartido) →
-- cuentas (orden global) → acta o cuadre de origen; las cifras se releen bajo bloqueo (dos resoluciones
-- simultáneas de lo mismo: exactamente una).
create function adex.difference_resolve(p_operation_id uuid, p_source_kind text, p_source_id text, p_resolution text, p_amount bigint, p_reason text)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_route   text;
    v_custody text;
    v_worker  text;
    v_holder  text;
    v_ctrl    text;
    v_model   text;
    i         record;
    v_allowed text[];
    v_accts   text[] := '{}';
    v_amts    bigint[] := '{}';
    v_lock    text[] := '{}';
    v_base    text; v_diff text; v_sus text; v_uni text; v_cash text;
    v_op      text;
    v_id      text := gen_random_uuid()::text;
    v_carried bigint;
    v_label   text;
    v_reason  text := btrim(coalesce(p_reason, ''));
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only the responsible administrator conciliates differences'); end if;
    if p_source_kind is null or p_source_kind not in ('handover', 'settlement_shortage', 'settlement_surplus') or p_source_id is null
       or p_resolution is null or p_resolution not in ('route_shortage', 'worker_owes', 'surplus_to_base', 'surplus_returned') then
      perform adex.capital_raise('AX411', 'sourceKind, sourceId and a valid resolution are required');
    end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if length(v_reason) < 10 or length(v_reason) > 500 then perform adex.capital_raise('AX803', 'a conciliation needs a reason (10+ characters)'); end if;
    if exists (select 1 from adex.difference_conciliations where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_source_kind = 'handover' then
      select route_id, to_membership_id into v_route, v_holder from adex.route_handover_records where company_id = x.company and id = p_source_id;
    else
      select route_id, custody_account_id, worker_membership_id, receiver_admin_membership_id into v_route, v_custody, v_worker, v_holder
        from adex.custody_settlements where company_id = x.company and id = p_source_id;
    end if;
    if v_route is null or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'difference not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    v_ctrl := adex.route_valid_controller(x.company, v_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if x.actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the capital controller of the route conciliates its differences'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    -- Nadie concilia su propio efectivo (tampoco con otra membresía de la misma persona).
    if v_worker is not null and adex.same_person(x.company, x.actor, v_worker) then perform adex.capital_raise('AX801', 'nobody conciliates their own cash'); end if;
    v_model := adex.company_capital_model(x.company);
    if p_source_kind = 'handover' and v_model is distinct from 'route_base' then
      perform adex.capital_raise('AX428', 'the route base model is not active in this company');
    end if;
    if v_model = 'route_base' and adex.route_in_handover(x.company, v_route) and (p_source_kind = 'handover' or p_resolution = 'surplus_to_base') then
      perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
    end if;
    if v_model = 'migrating' and p_source_kind = 'settlement_surplus' and p_resolution = 'surplus_to_base' then
      perform adex.capital_raise('AX422', 'the capital model of the company is being migrated');
    end if;

    -- Cuentas que se tocarían (y la custodia, que serializa las decisiones sobre un faltante), en orden global.
    v_diff := adex.capital_account_for(x.company, 'route_difference', null, v_route);
    if p_source_kind = 'handover' then
      v_base := adex.capital_account_for(x.company, 'route_base', null, v_route);
      v_lock := array[v_base, v_diff];
    elsif p_source_kind = 'settlement_shortage' then
      v_lock := array[v_custody, v_diff];
    else
      v_sus := adex.capital_account_for(x.company, 'suspense', v_holder, v_route);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, v_route);
      v_lock := array[v_sus, v_uni];
      if p_resolution = 'surplus_to_base' then
        v_cash := adex.route_cash_account(x.company, v_route, v_ctrl);
        v_lock := v_lock || v_cash || v_diff;
      end if;
    end if;
    perform adex.capital_lock_accounts(x.company, v_lock);
    if p_source_kind = 'handover' then
      perform 1 from adex.route_handover_records where company_id = x.company and id = p_source_id for update;
    else
      perform 1 from adex.custody_settlements where company_id = x.company and id = p_source_id for update;
    end if;

    -- Releída bajo bloqueo.
    select * into i from adex.difference_items_internal(x.company, v_route) d where d.source_kind = p_source_kind and d.source_id = p_source_id;
    if not found then perform adex.capital_raise('AX435', 'the difference is not pending (already conciliated or superseded)'); end if;
    v_allowed := adex.difference_resolutions(i.source_kind, i.kind, i.pending_minor);
    if not p_resolution = any(v_allowed) then perform adex.capital_raise('AX436', 'that resolution does not apply to this difference'); end if;
    if not (p_amount = i.pending_minor and i.pending_minor > 0
            or (p_source_kind = 'settlement_shortage' and p_resolution = 'route_shortage' and i.worker_owed_minor > 0
                and p_amount = i.pending_minor + i.worker_owed_minor)) then
      perform adex.capital_raise('AX438', 'the amount does not match the pending difference (it changed since the preview)');
    end if;

    v_label := case p_resolution when 'route_shortage' then 'faltante reconocido por la ruta' when 'worker_owes' then 'el trabajador repone'
                                 when 'surplus_to_base' then 'sobrante incorporado' else 'sobrante devuelto a su dueño' end;
    if p_source_kind = 'handover' and p_resolution = 'route_shortage' then
      v_accts := array[v_base, v_diff]; v_amts := array[-p_amount, p_amount];
    elsif p_source_kind = 'handover' and p_resolution = 'surplus_to_base' then
      v_accts := array[v_diff, v_base]; v_amts := array[-p_amount, p_amount];
    elsif p_source_kind = 'settlement_shortage' and p_resolution = 'route_shortage' then
      v_accts := array[v_custody, v_diff]; v_amts := array[-p_amount, p_amount];
    elsif p_source_kind = 'settlement_surplus' and p_resolution = 'surplus_to_base' then
      v_accts := array[v_sus, v_cash, v_uni, v_diff]; v_amts := array[-p_amount, p_amount, p_amount, -p_amount];
    elsif p_source_kind = 'settlement_surplus' and p_resolution = 'surplus_returned' then
      v_accts := array[v_sus, v_uni]; v_amts := array[-p_amount, p_amount];
    end if;

    if p_source_kind = 'settlement_shortage' then
      v_carried := i.carried_minor - case when p_resolution = 'route_shortage' then p_amount else 0 end;
      -- El arrastre baja ANTES de la pata (el guardián de la custodia exige saldo ≥ arrastre).
      if p_resolution = 'route_shortage' then
        update adex.capital_accounts set carried_minor = v_carried, version = version + 1, updated_at = now()
         where company_id = x.company and id = v_custody;
      end if;
    end if;
    if cardinality(v_accts) > 0 then
      v_op := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, p_operation_id, 'DIFFERENCE_CONCILIATION', p_amount, x.currency, v_route, v_ctrl, v_worker,
              case when p_source_kind = 'settlement_surplus' then v_holder end,
              left('Conciliación: ' || v_label || ' · ' || v_reason, 300), x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, v_accts, v_amts);
    end if;
    insert into adex.difference_conciliations (id, company_id, operation_id, route_id, source_kind, handover_id, settlement_id, custody_account_id,
                                               worker_membership_id, holder_membership_id, expected_minor, counted_minor, difference_minor, amount_minor,
                                               resolution, carried_after_minor, reason, ledger_operation_id, capital_model, entry_date, actor_membership_id,
                                               actor_identity_id, actor_role, txid)
    values (v_id, x.company, p_operation_id, v_route, p_source_kind, case when p_source_kind = 'handover' then p_source_id end,
            case when p_source_kind <> 'handover' then p_source_id end, case when p_source_kind <> 'handover' then v_custody end,
            case when p_source_kind <> 'handover' then v_worker end, v_holder, i.expected_minor, i.counted_minor, i.difference_minor, p_amount,
            p_resolution, v_carried, v_reason, v_op, v_model, x.today, x.actor, x.identity, x.role, txid_current());
    return jsonb_build_object('conciliationId', v_id, 'operationId', v_op, 'sourceKind', p_source_kind, 'sourceId', p_source_id, 'routeId', v_route,
      'workerId', v_worker, 'holderId', v_holder, 'resolution', p_resolution, 'amountMinor', p_amount, 'expectedMinor', i.expected_minor,
      'countedMinor', i.counted_minor, 'differenceMinor', i.difference_minor, 'carriedAfterMinor', v_carried,
      'workerOwedAfterMinor', case when p_source_kind = 'settlement_shortage' then adex.custody_worker_owed(x.company, v_custody) end,
      'capitalModel', v_model, 'entryDate', x.today, 'movesMoney', v_op is not null);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- Sin cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'difference_conciliations_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('difference_conciliations_one_per_handover', 'difference_conciliations_one_per_surplus') then
        perform adex.capital_raise('AX435', 'the difference is not pending (already conciliated or superseded)');
      end if;
      raise;
  end $$;
revoke all on function adex.difference_resolve(uuid, text, text, text, bigint, text) from public;
grant execute on function adex.difference_resolve(uuid, text, text, text, bigint, text) to adex_api;

-- ============================================================
-- 5. RB-D1 · Desactivar un Administrador solo sin cuentas pendientes
-- ============================================================
-- Cuentas pendientes de un Administrador (lista vacía = puede desactivarse). Interno (disparador y API).
create function adex.admin_pending_accounts_internal(p_company text, p_membership text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    m adex.memberships; v jsonb := '[]'::jsonb; j jsonb; n bigint; k bigint; c int;
  begin
    select * into m from adex.memberships where company_id = p_company and id = p_membership;
    if not found or m.role <> 'admin' then return v; end if;
    -- 1. Responsable de capital de alguna ruta.
    select jsonb_agg(jsonb_build_object('routeId', r.id, 'name', r.name, 'status', r.status) order by r.name, r.id) into j
      from adex.routes r where r.company_id = p_company and r.capital_controller_membership_id = p_membership;
    if j is not null then v := v || jsonb_build_object('code', 'CAPITAL_CONTROLLER', 'count', jsonb_array_length(j), 'routes', j); end if;
    -- 2. Bolsa (con `route_base`: «sin asignar»).
    select balance_minor into n from adex.capital_accounts where company_id = p_company and kind = 'admin' and membership_id = p_membership;
    if coalesce(n, 0) <> 0 then
      v := v || jsonb_build_object('code', 'ADMIN_POOL_BALANCE', 'amountMinor', n, 'unassigned', adex.company_capital_model(p_company) = 'route_base');
    end if;
    -- 3. Reembolsos que la empresa le debe (obligación pendiente: el dinero no queda sin responsable).
    select -balance_minor into n from adex.capital_accounts where company_id = p_company and kind = 'admin_payable' and membership_id = p_membership;
    if coalesce(n, 0) <> 0 then v := v || jsonb_build_object('code', 'PENDING_REIMBURSEMENT', 'amountMinor', n); end if;
    -- 4. Actas de entrega pendientes (entrega o recibe).
    select jsonb_agg(jsonb_build_object('handoverId', h.id, 'routeId', h.route_id, 'role', case when h.from_membership_id = p_membership then 'entrega' else 'recibe' end)
                     order by h.started_at, h.id) into j
      from adex.route_handover_records h
     where h.company_id = p_company and h.status = 'pendiente' and p_membership in (h.from_membership_id, h.to_membership_id);
    if j is not null then v := v || jsonb_build_object('code', 'PENDING_HANDOVER', 'count', jsonb_array_length(j), 'items', j); end if;
    -- 5. Diferencias sin conciliar en las rutas que controla.
    select count(*), coalesce(sum(i.pending_minor) filter (where i.kind = 'faltante'), 0), coalesce(sum(i.pending_minor) filter (where i.kind = 'sobrante'), 0)
      into c, n, k
      from adex.routes r cross join lateral adex.difference_items_internal(p_company, r.id) i
     where r.company_id = p_company and r.capital_controller_membership_id = p_membership and i.pending_minor > 0;
    if c > 0 then v := v || jsonb_build_object('code', 'UNRESOLVED_DIFFERENCES', 'count', c, 'shortageMinor', n, 'surplusMinor', k); end if;
    -- 6. Traspasos entre Administradores pendientes.
    select count(*), coalesce(sum(amount_minor), 0) into c, n from adex.admin_transfers
     where company_id = p_company and state = 'pending' and p_membership in (origin_admin_membership_id, destination_admin_membership_id);
    if c > 0 then v := v || jsonb_build_object('code', 'PENDING_ADMIN_TRANSFERS', 'count', c, 'amountMinor', n); end if;
    -- 7. Solicitudes de capital pendientes (las pidió o debe atenderlas).
    select count(*), coalesce(sum(amount_minor), 0) into c, n from adex.capital_requests
     where company_id = p_company and state = 'pending' and (requester_membership_id = p_membership or holder_membership_id = p_membership);
    if c > 0 then v := v || jsonb_build_object('code', 'PENDING_CAPITAL_REQUESTS', 'count', c, 'amountMinor', n); end if;
    -- 8. Sobrantes en control a su nombre.
    select coalesce(sum(balance_minor), 0) into n from adex.capital_accounts where company_id = p_company and kind = 'suspense' and membership_id = p_membership;
    if n <> 0 then v := v || jsonb_build_object('code', 'SUSPENSE_BALANCE', 'amountMinor', n); end if;
    -- 9. Efectivo en custodia de OTRA membresía activa de la misma persona.
    if m.identity_id is not null then
      select coalesce(sum(a.balance_minor), 0), count(*) filter (where a.balance_minor <> 0 or a.carried_minor <> 0) into n, c
        from adex.capital_accounts a join adex.memberships o on o.company_id = a.company_id and o.id = a.membership_id
       where a.company_id = p_company and a.kind = 'custody' and o.identity_id = m.identity_id and o.id <> p_membership and o.status = 'activo';
      if c > 0 then v := v || jsonb_build_object('code', 'OTHER_MEMBERSHIP_CUSTODY', 'count', c, 'amountMinor', n); end if;
    end if;
    return v;
  end $$;
revoke all on function adex.admin_pending_accounts_internal(text, text) from public;

-- Diagnóstico para la interfaz: SuperAdmin (cualquier miembro) o el propio Administrador. También para
-- Administradores YA inactivos: lo que quede es un dato heredado (se informa, no se ajusta solo).
create function adex.admin_pending_accounts(p_membership text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company(); m adex.memberships; v jsonb;
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active()
       or not (adex.ctx_role() = 'superadmin' or adex.ctx_membership() = p_membership) then
      perform adex.capital_raise('42501', 'no authority to review this member');
    end if;
    select * into m from adex.memberships where company_id = v_company and id = p_membership;
    if not found then perform adex.capital_raise('AX412', 'member not found'); end if;
    v := adex.admin_pending_accounts_internal(v_company, p_membership);
    return jsonb_build_object('membershipId', m.id, 'role', m.role, 'status', m.status, 'applies', m.role = 'admin',
      'canDeactivate', m.status = 'activo' and jsonb_array_length(v) = 0, 'legacy', m.status <> 'activo' and jsonb_array_length(v) > 0,
      'blockers', v);
  end $$;
revoke all on function adex.admin_pending_accounts(text) from public;
grant execute on function adex.admin_pending_accounts(text) to adex_api;

-- Segunda barrera: ninguna vía (API, SQL directo) desactiva a un Administrador con cuentas pendientes.
create function adex.guard_admin_deactivation() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v jsonb;
  begin
    if old.status = 'activo' and new.status is distinct from 'activo' and old.role = 'admin' then
      v := adex.admin_pending_accounts_internal(new.company_id, new.id);
      if jsonb_array_length(v) > 0 then
        raise exception 'adex: the administrator has pending accounts: %', (select string_agg(b->>'code', ', ') from jsonb_array_elements(v) b)
          using errcode = 'AX433';
      end if;
    end if;
    return new;
  end $$;
revoke all on function adex.guard_admin_deactivation() from public;
create trigger memberships_admin_deactivation_guard before update of status on adex.memberships
  for each row execute function adex.guard_admin_deactivation();

-- ============================================================
-- 6. Regla rectora: el responsable VIGENTE de una ruta solo lo cambia la estructura (SuperAdmin)
-- ============================================================
-- La política de 0007 deja a un Administrador con la ruta en su alcance actualizar la fila de la ruta; sin
-- esta barrera podría hacerse responsable de una ruta ajena (aunque válida) por SQL directo. Un Administrador
-- solo puede fijar el primer responsable (ruta sin responsable) o sustituir a uno que ya no es válido
-- (lo hacen las reconciliaciones automáticas de la API); cambiar a un responsable VÁLIDO es del SuperAdmin.
create function adex.guard_route_controller_change() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  begin
    -- (SECURITY DEFINER: `current_user` es el propietario; quien llama se reconoce por `session_user` y su contexto.)
    if session_user = 'adex_api'
       and new.capital_controller_membership_id is distinct from old.capital_controller_membership_id
       and old.capital_controller_membership_id is not null
       and adex.ctx_role() is distinct from 'superadmin'
       and exists (select 1 from adex.memberships m
                    where m.company_id = old.company_id and m.id = old.capital_controller_membership_id and m.role = 'admin' and m.status = 'activo'
                      and exists (select 1 from adex.membership_routes mr where mr.company_id = old.company_id
                                    and mr.membership_id = m.id and mr.route_id = old.id)) then
      raise exception 'adex: only the SuperAdmin changes the valid capital controller of a route' using errcode = 'AX402';
    end if;
    return new;
  end $$;
revoke all on function adex.guard_route_controller_change() from public;
create trigger routes_controller_change_guard before update of capital_controller_membership_id on adex.routes
  for each row execute function adex.guard_route_controller_change();

-- ============================================================
-- 7. Visibilidad (aditiva)
-- ============================================================
create policy capital_accounts_route_difference_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and kind = 'route_difference'
         and (select adex.ctx_is(array['admin', 'supervisor']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
create policy capital_operations_conciliation_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and kind = 'DIFFERENCE_CONCILIATION'
         and (worker_membership_id = adex.ctx_membership() or counterpart_membership_id = adex.ctx_membership()
              or ((select adex.ctx_is(array['admin', 'supervisor'])) and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
-- RB-D7: el responsable vigente de las rutas aportantes ve el gasto general y el reembolso que puede corregir.
create policy expenses_general_route_ctx on adex.expenses for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and route_id is null and funding = 'routes'
         and adex.general_funding_in_scope(company_id, coalesce(reverses_id, id), null));   -- también su anulación
create policy admin_reimbursements_route_ctx on adex.admin_reimbursements for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and source = 'routes'
         and adex.general_funding_in_scope(company_id, null, id));
