-- ============================================================
-- 0037 · Autoridad del responsable de capital de la ruta · intervención R74 (regla definitiva)
-- ============================================================
-- REGLA DEFINITIVA DEL PROPIETARIO (prevalece sobre las reglas anteriores incompatibles):
--   «La autoridad financiera máxima de una ruta es su Administrador responsable de capital
--   (routes.capital_controller_membership_id): UNO por ruta, el que inyecta el capital y responde por su dinero.
--   No es cualquier usuario con el rol de Administrador.»
--   · El responsable, en SUS rutas, inyecta y administra el capital, revisa y concilia movimientos y diferencias, y
--     corrige, edita y anula operaciones, INCLUIDAS LAS QUE ÉL MISMO REGISTRÓ, resolviendo los efectos posteriores.
--     Sin autorizador definido, la autoridad financiera es suya. No necesita aprobación de otro Administrador, del
--     SuperAdmin, del Owner ni de un auditor.
--   · Los demás Administradores con acceso operativo a la ruta (`membership_routes`) conservan EXACTAMENTE sus
--     permisos operativos aprobados (ver la ruta, autorizar ventas, aprobar movimientos de cobradores…) y no ganan
--     autoridad de capital. Nada de lo aprobado se les quita y nada de lo del responsable se les extiende.
--   · Se impone en la interfaz, la API y PostgreSQL (responsable de la ruta + membresía activa + permiso concreto),
--     con aislamiento de empresa y de ruta. El cambio estructural de responsable sigue el procedimiento de entrega
--     (disparador `routes_controller_change_guard` de 0036, AX402). El SuperAdmin conserva estructura, supervisión
--     y activación del modelo; no sustituye al responsable financiero. La auditoría automática se mantiene y NO es
--     una revisión obligatoria.
--
-- QUÉ CAMBIA (inventario de comprobaciones «uno mismo» de la última definición de cada función: tmp/r74/w6/self-inventory-raw.txt):
--   1. Autocorrección. Se retira la independencia F5-D02 (AX717 «quien registró no anula») en la anulación de gastos
--      de ruta y de trabajador: el responsable anula también lo que él registró. AX717 queda SOLO para un gasto
--      cargado a la PROPIA custodia de quien anula (también con otra membresía de la misma persona): eso es su
--      efectivo, no una corrección de su ruta. Las demás anulaciones del responsable (cobros, entregas, inyecciones,
--      gastos generales, reembolsos) ya no tenían esa restricción. Se CONSERVAN: AX801 (nadie se cuadra ni concilia
--      su propio efectivo), AX505 (nadie resuelve su propia solicitud de venta o de ajuste), AX419 (nadie entrega a
--      su propia custodia), AX410 (nadie reduce su propia custodia), AX313 (nadie se asigna perfiles), AX416
--      (el Secretario que registra un traspaso no lo decide).
--   2. Anulaciones de Base que antes no tenían camino: el responsable anula un RETIRO de Base (el dinero vuelve a la
--      Base; contrapartida `route_funding`) y una TRANSFERENCIA entre rutas cuando controla las dos; si las rutas son
--      de responsables distintos, AX434 y se usa el procedimiento coordinado (3). El reparto de saldo «sin asignar»
--      sigue sin anulación (bolsas del modelo anterior).
--   3. Anulación coordinada de operaciones conjuntas con responsables distintos (gastos generales con aportes,
--      reembolsos pagados con varias rutas y transferencias entre rutas): cualquier responsable de una ruta afectada
--      PROPONE (motivo), cada otro responsable CONFIRMA SU parte desde su pantalla y, con la última confirmación, la
--      anulación COMPLETA se asienta en UNA transacción con las mismas funciones de anulación (asientos espejo
--      consistentes). Quien propone puede cancelar. Nadie toca dinero ajeno; nada se asienta por partes; sin
--      aprobación del SuperAdmin ni de un auditor. Las transferencias siguen siendo inmediatas (sin confirmación).
--   4. Reembolso de la obligación de OTRO Administrador eligiendo la obligación concreta (gasto pagado con dinero
--      propio): `admin_reimbursements.expense_id`, lista de obligaciones pendientes de la empresa sin acceso a las
--      rutas del beneficiario (`adex.admin_payable_items`) y pago que reduce EXACTAMENTE esa obligación. Un gasto
--      con dinero propio con reembolsos enlazados vigentes no se anula (AX432) hasta anularlos.
--   5. Dependencias explicadas: `adex.expense_reversal_dependencies` (reembolsos que impiden anular un gasto con
--      dinero propio y quién puede anularlos). La API arma una sola transacción «anular reembolsos y gasto».
--
-- Aditiva: no cambia ni borra filas; sin propuestas conjuntas ni reembolsos enlazados, cada función redefinida se
-- comporta igual que en 0036 salvo las decisiones de la regla definitiva. Generado por tmp/r74/w6/build-0037.mjs
-- (copia literal de la última definición de cada función con reemplazos exactos).

-- ============================================================
-- 1. Esquema
-- ============================================================

-- ---------- Anulación de retiros de Base y de transferencias entre rutas (item 1) ----------
-- 0034 solo admitía anular la inyección; ahora también el retiro (vuelve a la Base) y la transferencia (vuelve a la
-- ruta de origen desde la de destino). El reparto de «sin asignar» sigue sin anulación.
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
                                                   'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER'));

-- ---------- Reembolso de una obligación concreta (item 4) ----------
alter table adex.admin_reimbursements add column expense_id adex.eid;
alter table adex.admin_reimbursements add constraint admin_reimbursements_expense_fk
  foreign key (company_id, expense_id) references adex.expenses(company_id, id);
create index admin_reimbursements_expense on adex.admin_reimbursements (company_id, expense_id) where expense_id is not null;

-- ---------- Anulaciones coordinadas (item 3) ----------
create table adex.joint_reversal_proposals (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  operation_id               uuid not null,                         -- X-Adex-Operation-Id de la propuesta
  target_kind                text not null check (target_kind in ('expense', 'reimbursement', 'route_transfer')),
  target_id                  adex.eid not null,                     -- gasto, reembolso u operación ROUTE_TRANSFER
  amount_minor               bigint not null check (amount_minor > 0),
  reason                     text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  status                     text not null default 'pending' check (status in ('pending', 'posted', 'cancelled', 'obsolete')),
  proposed_by_membership_id  adex.eid not null,
  proposed_by_identity_id    uuid not null references adex.identities(id),
  created_at                 timestamptz not null default now(),
  closed_at                  timestamptz,
  closed_by_membership_id    adex.eid,
  close_reason               text check (close_reason is null or length(close_reason) <= 300),
  posting_operation_id       uuid,                                  -- id de la anulación asentada (= el de la última confirmación)
  result                     jsonb,
  unique (company_id, id),
  constraint joint_reversal_proposals_operation_key unique (company_id, operation_id),
  check ((status = 'pending') = (closed_at is null)),
  check ((status = 'posted') = (posting_operation_id is not null)),
  foreign key (company_id, proposed_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, closed_by_membership_id) references adex.memberships(company_id, id)
);
-- Una sola propuesta pendiente por operación (dos propuestas simultáneas: exactamente una).
create unique index joint_reversal_proposals_one_pending on adex.joint_reversal_proposals (company_id, target_kind, target_id) where status = 'pending';
create index joint_reversal_proposals_company on adex.joint_reversal_proposals (company_id, status, created_at);

create table adex.joint_reversal_parts (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  proposal_id                 adex.eid not null,
  route_id                    adex.eid not null,
  amount_minor                bigint not null check (amount_minor > 0),  -- lo que esa ruta recupera (+) o devuelve (transferencia: destino)
  direction                   text not null check (direction in ('returns_to_route', 'leaves_route')),
  controller_membership_id    adex.eid not null,                     -- responsable al proponer (informativo)
  confirmed_at                timestamptz,
  confirmed_by_membership_id  adex.eid,
  confirm_operation_id        uuid,
  unique (company_id, id),
  constraint joint_reversal_parts_route_key unique (company_id, proposal_id, route_id),
  check ((confirmed_at is null) = (confirmed_by_membership_id is null)),
  foreign key (company_id, proposal_id) references adex.joint_reversal_proposals(company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, controller_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, confirmed_by_membership_id) references adex.memberships(company_id, id)
);
create index joint_reversal_parts_route on adex.joint_reversal_parts (company_id, route_id);

-- Historia inmutable: quién propuso, confirmó, canceló o asentó (y las confirmaciones que dejaron de valer).
create table adex.joint_reversal_events (
  id                   adex.eid primary key,
  company_id           adex.eid not null references adex.companies(id),
  proposal_id          adex.eid not null,
  operation_id         uuid,
  event                text not null check (event in ('propose', 'confirm', 'cancel', 'post', 'obsolete', 'confirmation_reset')),
  route_ids            text[] not null default '{}',
  actor_membership_id  adex.eid not null,
  actor_identity_id    uuid not null references adex.identities(id),
  txid                 bigint not null,
  created_at           timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, proposal_id) references adex.joint_reversal_proposals(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
-- Idempotencia: un X-Adex-Operation-Id por acción (proponer, confirmar o cancelar).
create unique index joint_reversal_events_operation_key on adex.joint_reversal_events (company_id, operation_id)
  where event in ('propose', 'confirm', 'cancel');
create index joint_reversal_events_proposal on adex.joint_reversal_events (company_id, proposal_id, created_at);

-- Las propuestas y sus partes solo cambian por las funciones de este archivo (sin permisos de escritura para la API):
-- nunca se borran; una propuesta cerrada no vuelve a cambiar; la parte solo cambia su confirmación.
create function adex.guard_joint_reversal() returns trigger
  language plpgsql
  as $$ begin
    if tg_op = 'DELETE' then raise exception 'adex: joint reversal records are never deleted' using errcode = '42501'; end if;
    if tg_table_name = 'joint_reversal_proposals' then
      if old.status <> 'pending'
         or (to_jsonb(new) - 'status' - 'closed_at' - 'closed_by_membership_id' - 'close_reason' - 'posting_operation_id' - 'result')
            is distinct from (to_jsonb(old) - 'status' - 'closed_at' - 'closed_by_membership_id' - 'close_reason' - 'posting_operation_id' - 'result') then
        raise exception 'adex: joint reversal proposal % is immutable', old.id using errcode = '42501';
      end if;
    elsif (to_jsonb(new) - 'confirmed_at' - 'confirmed_by_membership_id' - 'confirm_operation_id')
          is distinct from (to_jsonb(old) - 'confirmed_at' - 'confirmed_by_membership_id' - 'confirm_operation_id') then
      raise exception 'adex: joint reversal part % is immutable', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
revoke all on function adex.guard_joint_reversal() from public;
create trigger joint_reversal_proposals_guard before update or delete on adex.joint_reversal_proposals for each row execute function adex.guard_joint_reversal();
create trigger joint_reversal_parts_guard before update or delete on adex.joint_reversal_parts for each row execute function adex.guard_joint_reversal();
do $$
begin
  execute 'create trigger joint_reversal_proposals_no_truncate before truncate on adex.joint_reversal_proposals for each statement execute function adex.reject_mutation()';
  execute 'create trigger joint_reversal_parts_no_truncate before truncate on adex.joint_reversal_parts for each statement execute function adex.reject_mutation()';
  execute 'create trigger joint_reversal_events_immutable before update or delete on adex.joint_reversal_events for each row execute function adex.reject_mutation()';
  execute 'create trigger joint_reversal_events_no_truncate before truncate on adex.joint_reversal_events for each statement execute function adex.reject_mutation()';
end $$;

-- ¿Ve el contexto esta propuesta? SuperAdmin (solo lectura), quien la propuso y el responsable (vigente, al
-- proponer o que confirmó) de alguna ruta afectada. SECURITY DEFINER para no encadenar políticas.
create function adex.joint_proposal_visible(p_company text, p_proposal text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.api_scope_ok(p_company) and (
         adex.ctx_role() = 'superadmin'
      or exists (select 1 from adex.joint_reversal_proposals p where p.company_id = p_company and p.id = p_proposal
                   and p.proposed_by_membership_id = adex.ctx_membership())
      or (adex.ctx_role() = 'admin' and exists (
            select 1 from adex.joint_reversal_parts t where t.company_id = p_company and t.proposal_id = p_proposal
               and adex.ctx_membership() in (t.controller_membership_id, t.confirmed_by_membership_id, adex.route_valid_controller(p_company, t.route_id)))))
  $$;
revoke all on function adex.joint_proposal_visible(text, text) from public;
grant execute on function adex.joint_proposal_visible(text, text) to adex_api;

alter table adex.joint_reversal_proposals enable row level security;
alter table adex.joint_reversal_proposals force row level security;
create policy owner_joint_proposals_all on adex.joint_reversal_proposals for all to adex_owner using (true) with check (true);
create policy joint_proposals_ctx on adex.joint_reversal_proposals for select to adex_api
  using (company_id = adex.ctx_company() and adex.joint_proposal_visible(company_id, id));
grant select on adex.joint_reversal_proposals to adex_api;
alter table adex.joint_reversal_parts enable row level security;
alter table adex.joint_reversal_parts force row level security;
create policy owner_joint_parts_all on adex.joint_reversal_parts for all to adex_owner using (true) with check (true);
create policy joint_parts_ctx on adex.joint_reversal_parts for select to adex_api
  using (company_id = adex.ctx_company() and adex.joint_proposal_visible(company_id, proposal_id));
grant select on adex.joint_reversal_parts to adex_api;
alter table adex.joint_reversal_events enable row level security;
alter table adex.joint_reversal_events force row level security;
create policy owner_joint_events_all on adex.joint_reversal_events for all to adex_owner using (true) with check (true);
create policy joint_events_ctx on adex.joint_reversal_events for select to adex_api
  using (company_id = adex.ctx_company() and adex.joint_proposal_visible(company_id, proposal_id));
grant select on adex.joint_reversal_events to adex_api;

-- ============================================================
-- 2. Ayudantes
-- ============================================================

-- ¿Se está asentando AHORA, dentro de `joint_reversal_confirm`, la anulación coordinada de este objetivo? Verdadero
-- solo si la propuesta indicada por la variable de transacción `adex.joint_posting` está pendiente, es de ese
-- objetivo y TODAS sus partes están confirmadas por el responsable VIGENTE de cada ruta. Esa situación solo existe
-- dentro de la transacción de la última confirmación (que asienta y cierra la propuesta en la misma sentencia), de
-- modo que fijar la variable desde fuera no concede nada que los responsables no hayan confirmado. Interno.
create function adex.joint_posting_ok(p_company text, p_kind text, p_target text) returns boolean
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_id text := nullif(current_setting('adex.joint_posting', true), '');
  begin
    if v_id is null then return false; end if;
    return exists (select 1 from adex.joint_reversal_proposals p where p.company_id = p_company and p.id = v_id and p.status = 'pending'
                     and p.target_kind = p_kind and p.target_id = p_target)
       and not exists (select 1 from adex.joint_reversal_parts t where t.company_id = p_company and t.proposal_id = v_id
                         and t.confirmed_by_membership_id is distinct from adex.route_valid_controller(p_company, t.route_id));
  end $$;
revoke all on function adex.joint_posting_ok(text, text, text) from public;

-- Obligaciones pendientes con un Administrador, por gasto pagado con dinero propio (o de todos con p_admin NULL).
-- Pendiente de cada gasto = importe − reembolsos vigentes ENLAZADOS a él − su parte de los reembolsos vigentes SIN
-- enlace (reparto del más antiguo al más reciente). Σ pendientes = −saldo de `admin_payable`. Interno.
create function adex.admin_payable_items_internal(p_company text, p_admin text)
  returns table (expense_id text, admin_id text, amount_minor bigint, linked_minor bigint, unlinked_applied_minor bigint, pending_minor bigint,
                 expense_date date, created_at timestamptz, description text, category_id text, scope text)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    with e as (
      select x.id, x.responsible_admin_membership_id adm, x.amount_minor amt, x.expense_date, x.created_at, x.description, x.category_id, x.scope,
             coalesce((select sum(r.amount_minor) from adex.admin_reimbursements r
                        where r.company_id = x.company_id and r.expense_id = x.id and r.reversed_at is null), 0)::bigint linked
        from adex.expenses x
       where x.company_id = p_company and x.funding = 'own_money' and x.ledger_operation_id is not null
         and x.reverses_id is null and x.reversal_id is null and (p_admin is null or x.responsible_admin_membership_id = p_admin)
    ), r as (
      select e.*, greatest(0, e.amt - e.linked)::bigint rest,
             coalesce(sum(greatest(0, e.amt - e.linked)) over (partition by e.adm order by e.expense_date, e.created_at, e.id
                                                              rows between unbounded preceding and 1 preceding), 0)::bigint before
        from e
    ), u as (
      select r.adm, coalesce((select sum(z.amount_minor) from adex.admin_reimbursements z
                               where z.company_id = p_company and z.admin_membership_id = r.adm and z.expense_id is null and z.reversed_at is null), 0)::bigint unl
        from (select distinct adm from r) r
    )
    select r.id::text, r.adm::text, r.amt, r.linked, least(r.rest, greatest(0, u.unl - r.before))::bigint,
           (r.rest - least(r.rest, greatest(0, u.unl - r.before)))::bigint, r.expense_date, r.created_at, r.description, r.category_id::text, r.scope
      from r join u on u.adm = r.adm
     order by r.adm, r.expense_date, r.created_at, r.id
  $$;
revoke all on function adex.admin_payable_items_internal(text, text) from public;

-- Rutas afectadas por la anulación de una operación conjunta: (ruta, importe, sentido). Interno.
--   expense / reimbursement: cada ruta aportante recupera su aporte;
--   route_transfer: la de origen recupera y la de destino devuelve el importe.
create function adex.joint_reversal_routes(p_company text, p_kind text, p_target text)
  returns table (route_id text, amount_minor bigint, direction text)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select g.route_id::text, g.amount_minor, 'returns_to_route'::text from adex.general_funding_contributions g
     where p_kind = 'expense' and g.company_id = p_company and g.expense_id = p_target and g.route_id is not null
    union all
    select g.route_id::text, g.amount_minor, 'returns_to_route' from adex.general_funding_contributions g
     where p_kind = 'reimbursement' and g.company_id = p_company and g.reimbursement_id = p_target and g.route_id is not null
    union all
    select o.route_id::text, o.amount_minor, 'returns_to_route' from adex.capital_operations o
     where p_kind = 'route_transfer' and o.company_id = p_company and o.id = p_target and o.kind = 'ROUTE_TRANSFER'
    union all
    select o.to_route_id::text, o.amount_minor, 'leaves_route' from adex.capital_operations o
     where p_kind = 'route_transfer' and o.company_id = p_company and o.id = p_target and o.kind = 'ROUTE_TRANSFER'
  $$;
revoke all on function adex.joint_reversal_routes(text, text, text) from public;

-- ============================================================
-- 3. Funciones redefinidas (copia literal + cambios mínimos)
-- ============================================================

-- expense_correctable: la de 0036_admin_authority_reconciliation.sql.
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
        -- R74 (0037): con responsables distintos, la anulación coordinada confirmada por todos (joint_reversal_confirm).
        if not adex.joint_posting_ok(x.company, 'expense', e.id) then
          perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                      where g.company_id = x.company and g.expense_id = e.id order by g.route_id), x.actor);
        end if;
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
      -- R74 (0037, regla definitiva): el responsable de capital anula también lo que ÉL registró (sin la independencia
      -- F5-D02). Se conserva una sola barrera de persona: nadie anula un gasto cargado a SU propia custodia (tampoco
      -- con otra membresía): es su efectivo, no una corrección de la ruta.
      if e.collector_membership_id is not null and adex.same_person(x.company, x.actor, e.collector_membership_id) then
        perform adex.capital_raise('AX717', 'nobody reverses an expense charged to their own custody');
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

-- general_expense_reverse: la de 0035_general_expenses_funding.sql.
create or replace function adex.general_expense_reverse(x adex.money_ctx, p_operation_id uuid, p_expense text, p_reason text) returns jsonb
  language plpgsql
  as $$
  declare
    e        adex.expenses;
    o        adex.capital_operations;
    v_rev    text := gen_random_uuid()::text;
    v_first  text;
    v_op     text;
    v_expacc text;
    v_payable text;
    v_accts  text[] := '{}';
    v_ops    jsonb := '[]'::jsonb;
    v_n      int := 0;
    c        record;
  begin
    select * into e from adex.expenses where company_id = x.company and id = p_expense;
    select * into o from adex.capital_operations where company_id = x.company and id = e.ledger_operation_id;
    v_expacc := adex.capital_account_for(x.company, 'expense', null, null);
    if e.funding = 'own_money' then
      v_payable := adex.capital_account_for(x.company, 'admin_payable', e.responsible_admin_membership_id, null);
      perform adex.capital_lock_accounts(x.company, array[v_payable, v_expacc]);
      -- R74 (0037): un reembolso ENLAZADO a este gasto se anula antes (la API ofrece hacerlo en la misma transacción).
      if exists (select 1 from adex.admin_reimbursements z where z.company_id = x.company and z.expense_id = e.id and z.reversed_at is null) then
        perform adex.capital_raise('AX432', 'the obligation was already reimbursed: reverse the reimbursement first');
      end if;
      if (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable) + e.amount_minor > 0 then
        perform adex.capital_raise('AX432', 'the obligation was already reimbursed: reverse the reimbursement first');
      end if;
      v_first := gen_random_uuid()::text;
    else
      for c in select g.route_id from adex.general_funding_contributions g
                where g.company_id = x.company and g.expense_id = e.id order by g.route_id loop
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, e.scope) and not adex.joint_posting_ok(x.company, 'expense', e.id) then
          perform adex.capital_raise('AX430', 'the money returns to each route base: you must still be the capital controller of every contributing route');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end loop;
      perform adex.capital_lock_accounts(x.company, v_accts || v_expacc);
      v_first := gen_random_uuid()::text;
    end if;
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, responsible_admin_membership_id, sync_status, created_at,
                               reverses_id, reversal_reason, ledger_operation_id)
    values (v_rev, x.company, null, e.scope, e.category_id, -e.amount_minor, 'Anulación: ' || p_reason, x.today, x.actor, null, e.funding, null,
            e.responsible_admin_membership_id, 'synced', now(), e.id, p_reason, v_first);
    update adex.expenses set reversal_id = v_rev, reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = p_reason
     where company_id = x.company and id = e.id;
    if e.funding = 'own_money' then
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           expense_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_first, x.company, p_operation_id, 'REVERSAL', e.amount_minor, x.currency, null, e.responsible_admin_membership_id, v_rev, o.id,
              'GENERAL_EXPENSE_OWN_MONEY', p_reason, x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_first, array[v_payable, v_expacc], array[e.amount_minor, -e.amount_minor]);
      v_ops := jsonb_build_array(v_first);
    else
      for c in select g.route_id, g.amount_minor, g.operation_id from adex.general_funding_contributions g
                where g.company_id = x.company and g.expense_id = e.id order by g.route_id loop
        v_n := v_n + 1;
        v_op := case when v_n = 1 then v_first else gen_random_uuid()::text end;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             expense_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id,
                coalesce(adex.route_valid_controller(x.company, c.route_id), x.actor), v_rev,
                c.operation_id, 'GENERAL_EXPENSE_CONTRIBUTION', p_reason, x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_expacc],
                                        array[c.amount_minor, -c.amount_minor]);
        v_ops := v_ops || to_jsonb(v_op);
      end loop;
    end if;
    return jsonb_build_object('reversalExpenseId', v_rev, 'operationId', v_first, 'operationIds', v_ops, 'expenseId', e.id, 'amountMinor', e.amount_minor,
                              'reversalDate', x.today, 'periodClosed', false);
  end $$;

-- admin_reimbursement_reverse: la de 0036_admin_authority_reconciliation.sql.
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
      -- R74 (0037): con responsables distintos, la anulación coordinada confirmada por todos (joint_reversal_confirm).
      if not adex.joint_posting_ok(x.company, 'reimbursement', r.id) then
        perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                    where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id), x.actor);
      end if;
    end if;
    v_payable := adex.capital_account_for(x.company, 'admin_payable', r.admin_membership_id, null);
    for c in select g.route_id from adex.general_funding_contributions g
              where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id loop
      if c.route_id is null then
        v_accts := v_accts || adex.capital_account_for(x.company, 'admin', x.actor, null);
      else
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, 'reembolso') and not adex.joint_posting_ok(x.company, 'reimbursement', r.id) then
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
      values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id,
              case when c.route_id is null then x.actor else coalesce(adex.route_valid_controller(x.company, c.route_id), x.actor) end,
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

-- admin_reimbursement_post: la de 0035_general_expenses_funding.sql.
create or replace function adex.admin_reimbursement_post(p_operation_id uuid, p_admin text, p_amount bigint, p_contributions jsonb, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_model   text;
    v_payable text;
    v_pool    text;
    v_total   bigint;
    v_pending bigint;
    v_id      text := gen_random_uuid()::text;
    v_op      text;
    v_accts   text[] := '{}';
    v_ops     jsonb := '[]'::jsonb;
    v_contrib jsonb := '[]'::jsonb;
    c         record;
    v_cname   text;
    -- R74 (0037): obligación elegida (gasto con dinero propio). Llega por la variable de transacción
    -- `adex.reimburse_expense` (la fija `admin_reimbursement_pay`); todo se valida aquí, bajo bloqueo.
    v_expense text := nullif(current_setting('adex.reimburse_expense', true), '');
    v_item_pending bigint;
  begin
    perform set_config('adex.reimburse_expense', '', true);
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator pays reimbursements'); end if;
    if not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no reimbursement authority'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if p_admin is null or not exists (select 1 from adex.memberships where company_id = x.company and id = p_admin and role = 'admin') then
      perform adex.capital_raise('AX412', 'administrator not found');
    end if;
    if exists (select 1 from adex.admin_reimbursements where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    v_model := adex.company_capital_model(x.company);
    v_payable := adex.capital_account_for(x.company, 'admin_payable', p_admin, null);
    if v_model = 'route_base' then
      if p_contributions is null or p_contributions = 'null'::jsonb then perform adex.capital_raise('AX429', 'contributions are required'); end if;
      select coalesce(sum(amount_minor), 0) into v_total from adex.general_contributions_parse(p_contributions);
      if p_amount is not null and p_amount <> v_total then perform adex.capital_raise('AX429', 'the contributions must add up to the amount'); end if;
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        if not adex.ctx_route_allowed(c.route_id) or not exists (select 1 from adex.routes where company_id = x.company and id = c.route_id) then
          perform adex.capital_raise('AX412', 'route not found');
        end if;
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if adex.route_valid_controller(x.company, c.route_id) is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, 'reembolso') then
          perform adex.capital_raise('AX430', 'a route contributes only when you are its capital controller');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        if adex.route_in_handover(x.company, c.route_id) then
          perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
        end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end loop;
    elsif v_model = 'admin_pool' then
      if p_contributions is not null and p_contributions <> 'null'::jsonb then
        perform adex.capital_raise('AX429', 'without the route base model the reimbursement is paid from your pool: send amountMinor only');
      end if;
      if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
      v_total := p_amount;
      v_pool := adex.capital_account_for(x.company, 'admin', x.actor, null);
      v_accts := array[v_pool];
    else
      perform adex.capital_raise('AX422', 'the capital model of the company is being migrated');
    end if;
    perform adex.capital_lock_accounts(x.company, v_accts || v_payable);
    select -balance_minor into v_pending from adex.capital_accounts where company_id = x.company and id = v_payable;
    if v_total > v_pending then perform adex.capital_raise('AX431', 'the reimbursement exceeds what the company owes this administrator'); end if;
    if v_expense is not null then
      select i.pending_minor into v_item_pending from adex.admin_payable_items_internal(x.company, p_admin) i where i.expense_id = v_expense;
      if not found then perform adex.capital_raise('AX412', 'obligation not found for this administrator'); end if;
      if v_total > v_item_pending then perform adex.capital_raise('AX431', 'the reimbursement exceeds what is pending on this obligation'); end if;
    end if;

    insert into adex.admin_reimbursements (id, company_id, operation_id, admin_membership_id, payer_membership_id, amount_minor, source, reason, entry_date,
                                           actor_identity_id, txid, expense_id)
    values (v_id, x.company, p_operation_id, p_admin, x.actor, v_total, case when v_pool is null then 'routes' else 'admin_pool' end, btrim(p_reason), x.today,
            x.identity, txid_current(), v_expense);
    if v_pool is not null then
      v_op := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, p_operation_id, 'ADMIN_REIMBURSEMENT', v_total, x.currency, null, x.actor, p_admin, btrim(p_reason), x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_pool, v_payable], array[-v_total, v_total]);
      insert into adex.general_funding_contributions (id, company_id, purpose, reimbursement_id, route_id, amount_minor, operation_id, controller_membership_id)
      values (gen_random_uuid()::text, x.company, 'reimbursement', v_id, null, v_total, v_op, x.actor);
      v_ops := jsonb_build_array(v_op);
      v_contrib := jsonb_build_array(jsonb_build_object('routeId', null, 'amountMinor', v_total, 'operationId', v_op));
    else
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        v_op := gen_random_uuid()::text;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, c.n), 'ADMIN_REIMBURSEMENT', c.amount_minor, x.currency, c.route_id,
                x.actor, p_admin, btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_payable],
                                        array[-c.amount_minor, c.amount_minor]);
        insert into adex.general_funding_contributions (id, company_id, purpose, reimbursement_id, route_id, amount_minor, operation_id, controller_membership_id)
        values (gen_random_uuid()::text, x.company, 'reimbursement', v_id, c.route_id, c.amount_minor, v_op, x.actor);
        v_ops := v_ops || to_jsonb(v_op);
        v_contrib := v_contrib || jsonb_build_object('routeId', c.route_id, 'amountMinor', c.amount_minor, 'operationId', v_op);
      end loop;
    end if;
    return jsonb_build_object('reimbursementId', v_id, 'adminId', p_admin, 'payerId', x.actor, 'amountMinor', v_total, 'operationIds', v_ops,
                              'contributions', v_contrib, 'pendingBeforeMinor', v_pending, 'pendingAfterMinor', v_pending - v_total, 'entryDate', x.today,
                              'source', case when v_pool is null then 'routes' else 'admin_pool' end, 'expenseId', v_expense,
                              'obligationPendingAfterMinor', case when v_expense is not null then v_item_pending - v_total end);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      if v_cname = 'capital_accounts_admin_payable_sign' then perform adex.capital_raise('AX431', 'the reimbursement exceeds what the company owes this administrator'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'admin_reimbursements_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- route_base_post: la de 0034_route_base.sql.
create or replace function adex.route_base_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text,
  p_to_route     text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_reversal boolean := p_kind = 'REVERSAL';
    v_kind     text := p_kind;
    v_amount   bigint := p_amount;
    v_route    text := p_route;
    v_to       text := p_to_route;
    v_orig     adex.capital_operations;
    v_ctrl     text;
    v_ctrl2    text;
    v_currency char(3);
    v_date     date;
    v_accts    text[];
    v_amts     bigint[];
    v_op       adex.capital_operations;
    v_bal      bigint;
    v_i        int;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    -- E2: el SuperAdmin supervisa; la Base la mueve el Administrador responsable de la ruta.
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only the responsible administrator moves the base of a route'); end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if adex.company_capital_model(v_company) is distinct from 'route_base' then
      perform adex.capital_raise('AX428', 'the route base model is not active in this company');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      -- R74 (0037, regla definitiva): el responsable anula también un retiro de Base (el dinero vuelve a la Base) y una
      -- transferencia entre rutas (la de destino devuelve; con responsables distintos, anulación coordinada).
      if v_orig.kind = 'LEGACY_POOL_TO_ROUTE' then perform adex.capital_raise('AX404', 'an assignment of unassigned capital cannot be reversed'); end if;
      if v_orig.kind not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER') then perform adex.capital_raise('AX404', 'not a route base operation'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to := v_orig.to_route_id;
    end if;

    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if v_kind not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') or v_route is null
       or (v_kind = 'ROUTE_TRANSFER') <> (v_to is not null) or v_to = v_route then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;
    if not adex.ctx_route_allowed(v_route)
       and not (v_reversal and v_kind = 'ROUTE_TRANSFER' and (adex.ctx_route_allowed(v_to) or adex.joint_posting_ok(v_company, 'route_transfer', v_orig.id))) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;

    -- Rutas (orden de id) y responsables releídos bajo bloqueo (R5).
    perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to) order by id for update;
    if not exists (select 1 from adex.routes where company_id = v_company and id = v_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    v_ctrl := adex.route_valid_controller(v_company, v_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- La anulación de una transferencia se autoriza abajo (responsables de las dos rutas).
    if v_actor is distinct from v_ctrl and not (v_reversal and v_kind = 'ROUTE_TRANSFER') then
      perform adex.capital_raise('AX402', 'only the route capital controller moves its base');
    end if;
    if adex.capital_period_closed(v_company, v_route, v_date) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if adex.route_in_handover(v_company, v_route) then
      perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
    end if;
    if not v_reversal and v_kind in ('ROUTE_BASE_INJECTION', 'LEGACY_POOL_TO_ROUTE') and not adex.route_operational(v_company, v_route) then
      perform adex.capital_raise('AX301', 'route is not operational');
    end if;
    if v_kind = 'ROUTE_TRANSFER' then
      if not exists (select 1 from adex.routes where company_id = v_company and id = v_to) then perform adex.capital_raise('AX412', 'destination route not found'); end if;
      v_ctrl2 := adex.route_valid_controller(v_company, v_to);
      if v_ctrl2 is null then perform adex.capital_raise('AX408', 'the destination route has no valid capital controller'); end if;
      if not v_reversal and not adex.route_operational(v_company, v_to) then perform adex.capital_raise('AX301', 'destination route is not operational'); end if;
      if adex.capital_period_closed(v_company, v_to, v_date) then perform adex.capital_raise('AX407', 'the period of the destination route is closed'); end if;
      -- R74 (0037): anular una transferencia saca dinero de la Base de destino: lo hace quien controla LAS DOS rutas o,
      -- con responsables distintos, la anulación coordinada confirmada por ambos (AX434 si no).
      if v_reversal then
        if adex.route_in_handover(v_company, v_to) then
          perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
        end if;
        if not adex.joint_posting_ok(v_company, 'route_transfer', v_orig.id) and (v_actor is distinct from v_ctrl or v_actor is distinct from v_ctrl2) then
          if v_actor is distinct from v_ctrl and v_actor is distinct from v_ctrl2 then
            perform adex.capital_raise('AX402', 'only the capital controllers of the two routes reverse a transfer');
          end if;
          perform adex.capital_raise('AX434', 'the transfer joins routes of different administrators: reverse it with a joint reversal');
        end if;
      end if;
    end if;

    case v_kind
      when 'ROUTE_BASE_INJECTION'  then v_accts := array[adex.capital_account_for(v_company, 'route_funding', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_route)];
      when 'ROUTE_BASE_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_funding', null, v_route)];
      when 'ROUTE_TRANSFER'        then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_to)];
      else
        -- O3: el Administrador confirma el reparto de SU saldo «sin asignar» a una ruta de la que es responsable.
        if not exists (select 1 from adex.capital_accounts where company_id = v_company and kind = 'admin' and membership_id = v_actor) then
          perform adex.capital_raise('AX401', 'insufficient funds');
        end if;
        v_accts := array[adex.capital_account_for(v_company, 'admin', v_actor, null), adex.capital_account_for(v_company, 'route_base', null, v_route)];
    end case;
    if v_reversal then v_accts := array[v_accts[2], v_accts[1]]; end if;
    v_amts := array[-v_amount, v_amount];
    perform adex.capital_lock_accounts(v_company, v_accts);

    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, counterpart_membership_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to,
            v_ctrl, v_ctrl2, v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;
    for v_i in 1 .. 2 loop
      update adex.capital_accounts set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- Sin cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;


-- R74 (0037, item 4): reembolso de una obligación concreta (gasto pagado con dinero propio) de cualquier
-- Administrador de la empresa. Mismas reglas que `admin_reimbursement_post` (aportes de rutas del pagador o su
-- bolsa, nunca más de lo pendiente, idempotente); además no supera lo pendiente de ESA obligación y queda enlazado.
create function adex.admin_reimbursement_pay(p_operation_id uuid, p_admin text, p_amount bigint, p_contributions jsonb, p_reason text, p_expense text)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  begin
    if p_expense is null or length(p_expense) = 0 then perform adex.capital_raise('AX411', 'the obligation (expense) is required'); end if;
    perform set_config('adex.reimburse_expense', p_expense, true);
    return adex.admin_reimbursement_post(p_operation_id, p_admin, p_amount, p_contributions, p_reason);
  end $$;
revoke all on function adex.admin_reimbursement_pay(uuid, text, bigint, jsonb, text, text) from public;
grant execute on function adex.admin_reimbursement_pay(uuid, text, bigint, jsonb, text, text) to adex_api;

-- ============================================================
-- 4. Obligaciones con Administradores y dependencias de una anulación (items 2 y 4)
-- ============================================================

-- Obligaciones pendientes de la empresa con sus Administradores, por gasto pagado con dinero propio: beneficiario,
-- descripción, categoría, fecha, importe, reembolsado y pendiente. Sin rutas ni saldos de rutas del beneficiario.
-- Visible para todo Administrador activo (quien paga elige la obligación) y para el SuperAdmin (solo lectura).
create function adex.admin_payable_items() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() or not adex.ctx_is(array['superadmin', 'admin']) then
      perform adex.capital_raise('42501', 'no visibility of administrator obligations');
    end if;
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'expenseId', i.expense_id, 'adminId', i.admin_id, 'adminName', m.display_name, 'adminStatus', m.status,
               'description', i.description, 'categoryName', c.name, 'scope', i.scope, 'expenseDate', i.expense_date,
               'amountMinor', i.amount_minor, 'reimbursedMinor', i.amount_minor - i.pending_minor, 'pendingMinor', i.pending_minor,
               'isMine', i.admin_id = adex.ctx_membership(), 'isCash', false)
             order by m.display_name, i.admin_id, i.expense_date, i.created_at, i.expense_id)
        from adex.admin_payable_items_internal(v_company, null) i
        join adex.memberships m on m.company_id = v_company and m.id = i.admin_id
        left join adex.expense_categories c on c.company_id = v_company and c.id = i.category_id
       where i.pending_minor > 0), '[]'::jsonb);
  end $$;
revoke all on function adex.admin_payable_items() from public;
grant execute on function adex.admin_payable_items() to adex_api;

-- Un reembolso como dependencia de una anulación: quién lo pagó, de qué rutas y quién puede anularlo. Interno.
create function adex.reimbursement_dependency(p_company text, p_reimbursement text, p_linked boolean, p_actor text) returns jsonb
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    with r as (select * from adex.admin_reimbursements where company_id = p_company and id = p_reimbursement),
    g as (
      select g.route_id, ro.name, adex.route_valid_controller(p_company, g.route_id) ctrl
        from adex.general_funding_contributions g join r on g.company_id = p_company and g.reimbursement_id = r.id
        join adex.routes ro on ro.company_id = p_company and ro.id = g.route_id
    ), v as (
      select r.*, case when r.source = 'admin_pool' then r.payer_membership_id = p_actor
                       else not exists (select 1 from g where g.ctrl is distinct from p_actor) end reversible,
             exists (select 1 from g where g.ctrl = p_actor) touches_mine
        from r
    )
    select jsonb_build_object(
             'kind', 'reimbursement', 'id', v.id, 'linked', p_linked, 'amountMinor', v.amount_minor, 'entryDate', v.entry_date, 'source', v.source,
             'beneficiaryId', v.admin_membership_id, 'payerId', v.payer_membership_id,
             'payerName', (select display_name from adex.memberships where company_id = p_company and id = v.payer_membership_id),
             'label', 'Reembolso de ' || v.amount_minor || ' del ' || to_char(v.entry_date, 'YYYY-MM-DD'),
             'routes', coalesce((select jsonb_agg(jsonb_build_object('routeId', g.route_id, 'routeName', g.name, 'controllerId', g.ctrl,
                                                                    'controllerName', (select display_name from adex.memberships where company_id = p_company and id = g.ctrl),
                                                                    'isActor', g.ctrl is not distinct from p_actor) order by g.name, g.route_id) from g), '[]'::jsonb),
             'reversibleByActor', v.reversible,
             'action', case when v.reversible then 'reverse_reimbursement'
                            when v.source = 'routes' and v.touches_mine then 'propose_joint_reversal'
                            else 'ask_controller' end)
      from v
  $$;
revoke all on function adex.reimbursement_dependency(text, text, boolean, text) from public;

-- Reembolsos que impiden anular un gasto pagado con dinero propio (AX432): primero los ENLAZADOS a ese gasto y, si
-- aun así la obligación quedara a favor de la empresa, los más recientes sin enlace hasta cubrir el faltante. Cada
-- uno dice quién puede anularlo. Solo para quien puede ver el gasto (el acreedor o el SuperAdmin); si no, vacío.
create function adex.expense_reversal_dependencies(p_expense text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    e         adex.expenses;
    v_pending bigint;
    v_acc     bigint := 0;
    v_short   bigint;
    v_out     jsonb := '[]'::jsonb;
    r         record;
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() or not adex.ctx_is(array['superadmin', 'admin']) then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    select * into e from adex.expenses where company_id = v_company and id = p_expense;
    if not found or e.funding is distinct from 'own_money' or e.reverses_id is not null or e.reversal_id is not null or e.ledger_operation_id is null then
      return v_out;
    end if;
    if adex.ctx_role() <> 'superadmin' and e.responsible_admin_membership_id is distinct from v_actor then return v_out; end if;
    for r in select id, amount_minor from adex.admin_reimbursements where company_id = v_company and expense_id = e.id and reversed_at is null
              order by created_at desc, id loop
      v_out := v_out || adex.reimbursement_dependency(v_company, r.id, true, v_actor);
      v_acc := v_acc + r.amount_minor;
    end loop;
    select -balance_minor into v_pending from adex.capital_accounts
     where company_id = v_company and kind = 'admin_payable' and membership_id = e.responsible_admin_membership_id;
    v_short := e.amount_minor - (coalesce(v_pending, 0) + v_acc);
    if v_short > 0 then
      for r in select id, amount_minor from adex.admin_reimbursements
                where company_id = v_company and admin_membership_id = e.responsible_admin_membership_id and expense_id is null and reversed_at is null
                order by created_at desc, id loop
        exit when v_short <= 0;
        v_out := v_out || adex.reimbursement_dependency(v_company, r.id, false, v_actor);
        v_short := v_short - r.amount_minor;
      end loop;
    end if;
    return v_out;
  end $$;
revoke all on function adex.expense_reversal_dependencies(text) from public;
grant execute on function adex.expense_reversal_dependencies(text) to adex_api;

-- ============================================================
-- 5. Anulación coordinada (item 3)
-- ============================================================

-- Vista de una propuesta para el contexto (nombres de rutas y responsables e importes de ESTA operación; nunca
-- saldos de rutas ajenas). Interno: quien llama ya comprobó la visibilidad.
create function adex.joint_reversal_view(p_company text, p_proposal text) returns jsonb
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    with p as (select * from adex.joint_reversal_proposals where company_id = p_company and id = p_proposal),
    t as (
      select t.*, ro.name route_name, adex.route_valid_controller(p_company, t.route_id) ctrl
        from adex.joint_reversal_parts t join p on t.company_id = p_company and t.proposal_id = p.id
        join adex.routes ro on ro.company_id = p_company and ro.id = t.route_id
    ), me as (select adex.ctx_membership() id)
    select jsonb_build_object(
             'id', p.id, 'operationId', p.operation_id, 'targetKind', p.target_kind, 'targetId', p.target_id, 'amountMinor', p.amount_minor,
             'reason', p.reason, 'status', p.status, 'createdAt', p.created_at, 'closedAt', p.closed_at, 'closeReason', p.close_reason,
             'postingOperationId', p.posting_operation_id,
             'proposedBy', jsonb_build_object('membershipId', p.proposed_by_membership_id,
                                              'name', (select display_name from adex.memberships where company_id = p_company and id = p.proposed_by_membership_id)),
             'closedBy', p.closed_by_membership_id,
             'target', case p.target_kind
               when 'expense' then (select jsonb_build_object('description', x.description, 'categoryName', c.name, 'scope', x.scope, 'expenseDate', x.expense_date,
                                                              'responsibleId', x.responsible_admin_membership_id, 'state', case when x.reversal_id is null then 'vigente' else 'anulado' end)
                                      from adex.expenses x left join adex.expense_categories c on c.company_id = x.company_id and c.id = x.category_id
                                     where x.company_id = p_company and x.id = p.target_id)
               when 'reimbursement' then (select jsonb_build_object('beneficiaryId', r.admin_membership_id,
                                                                    'beneficiaryName', (select display_name from adex.memberships where company_id = p_company and id = r.admin_membership_id),
                                                                    'payerId', r.payer_membership_id, 'entryDate', r.entry_date, 'reason', r.reason,
                                                                    'state', case when r.reversed_at is null then 'vigente' else 'anulado' end)
                                            from adex.admin_reimbursements r where r.company_id = p_company and r.id = p.target_id)
               else (select jsonb_build_object('fromRouteId', o.route_id, 'fromRouteName', (select name from adex.routes where company_id = p_company and id = o.route_id),
                                               'toRouteId', o.to_route_id, 'toRouteName', (select name from adex.routes where company_id = p_company and id = o.to_route_id),
                                               'entryDate', o.entry_date, 'reason', o.reason,
                                               'state', case when exists (select 1 from adex.capital_operations z where z.company_id = p_company and z.reverses_operation_id = o.id)
                                                             then 'anulado' else 'vigente' end)
                       from adex.capital_operations o where o.company_id = p_company and o.id = p.target_id) end,
             'parts', coalesce((select jsonb_agg(jsonb_build_object(
                         'routeId', t.route_id, 'routeName', t.route_name, 'amountMinor', t.amount_minor, 'direction', t.direction,
                         'controllerId', t.ctrl, 'controllerName', (select display_name from adex.memberships where company_id = p_company and id = t.ctrl),
                         'confirmed', t.confirmed_by_membership_id is not null and t.confirmed_by_membership_id is not distinct from t.ctrl,
                         'confirmedAt', t.confirmed_at, 'confirmedBy', t.confirmed_by_membership_id,
                         'isMine', t.ctrl is not distinct from (select id from me)) order by t.route_name, t.route_id) from t), '[]'::jsonb),
             'pendingParts', (select count(*) from t where t.confirmed_by_membership_id is null or t.confirmed_by_membership_id is distinct from t.ctrl),
             'canConfirm', p.status = 'pending' and adex.ctx_role() = 'admin'
                           and exists (select 1 from t where t.ctrl is not distinct from (select id from me) and t.confirmed_by_membership_id is distinct from t.ctrl),
             'canCancel', p.status = 'pending' and adex.ctx_role() = 'admin'
                          and (p.proposed_by_membership_id = (select id from me)
                               or (not exists (select 1 from t where t.ctrl is not distinct from p.proposed_by_membership_id)
                                   and exists (select 1 from t where t.ctrl is not distinct from (select id from me))))
           )
      from p
  $$;
revoke all on function adex.joint_reversal_view(text, text) from public;

-- Propuestas visibles (`pending` o `all`), las más recientes primero.
create function adex.joint_reversal_list(p_status text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() or not adex.ctx_is(array['superadmin', 'admin']) then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    if p_status not in ('pending', 'all') then perform adex.capital_raise('AX411', 'status must be pending or all'); end if;
    return coalesce((
      select jsonb_agg(adex.joint_reversal_view(v_company, x.id) order by x.created_at desc, x.id)
        from (select p.id, p.created_at from adex.joint_reversal_proposals p
               where p.company_id = v_company and (p_status = 'all' or p.status = 'pending') and adex.joint_proposal_visible(v_company, p.id)
               order by p.created_at desc, p.id limit 200) x), '[]'::jsonb);
  end $$;
revoke all on function adex.joint_reversal_list(text) from public;
grant execute on function adex.joint_reversal_list(text) to adex_api;

-- Una propuesta concreta (404 / AX412 si no es visible).
create function adex.joint_reversal_get(p_proposal text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if not exists (select 1 from adex.joint_reversal_proposals where company_id = v_company and id = p_proposal)
       or not adex.joint_proposal_visible(v_company, p_proposal) then
      perform adex.capital_raise('AX412', 'proposal not found');
    end if;
    return adex.joint_reversal_view(v_company, p_proposal);
  end $$;
revoke all on function adex.joint_reversal_get(text) from public;
grant execute on function adex.joint_reversal_get(text) to adex_api;

-- PROPONER. Cualquier responsable de capital VÁLIDO de una ruta afectada, con motivo. Sus partes quedan confirmadas.
-- Si el actor controla TODAS las rutas no hace falta (AX440: que anule directamente).
create function adex.joint_reversal_propose(p_operation_id uuid, p_kind text, p_target text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_id       text := gen_random_uuid()::text;
    v_amount   bigint;
    v_mine     text[];
    v_ctrls    int;
    v_cname    text;
    e          adex.expenses;
    r          adex.admin_reimbursements;
    o          adex.capital_operations;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'joint reversals run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only a route capital controller proposes a joint reversal'); end if;
    if p_operation_id is null or p_target is null or p_kind is null or p_kind not in ('expense', 'reimbursement', 'route_transfer') then
      perform adex.capital_raise('AX411', 'operation id, kind and target are required');
    end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if exists (select 1 from adex.joint_reversal_events where company_id = v_company and operation_id = p_operation_id and event in ('propose', 'confirm', 'cancel')) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_kind = 'expense' then
      if not adex.ctx_can('expense.correct') then perform adex.capital_raise('42501', 'no expense correction authority'); end if;
      select * into e from adex.expenses where company_id = v_company and id = p_target for share;
      if not found then perform adex.capital_raise('AX412', 'expense not found'); end if;
      if e.reverses_id is not null or e.refunds_expense_id is not null then perform adex.capital_raise('AX404', 'a correction cannot be corrected'); end if;
      if e.funding is distinct from 'routes' then perform adex.capital_raise('AX404', 'only general expenses funded by routes are reversed jointly'); end if;
      if e.reversal_id is not null then perform adex.capital_raise('AX405', 'expense already reversed'); end if;
      v_amount := e.amount_minor;
    elsif p_kind = 'reimbursement' then
      if not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no reimbursement authority'); end if;
      select * into r from adex.admin_reimbursements where company_id = v_company and id = p_target for share;
      if not found then perform adex.capital_raise('AX412', 'reimbursement not found'); end if;
      if r.source is distinct from 'routes' then perform adex.capital_raise('AX404', 'only reimbursements paid by routes are reversed jointly'); end if;
      if r.reversed_at is not null then perform adex.capital_raise('AX405', 'reimbursement already reversed'); end if;
      v_amount := r.amount_minor;
    else
      select * into o from adex.capital_operations where company_id = v_company and id = p_target;
      if not found or o.kind is distinct from 'ROUTE_TRANSFER' then perform adex.capital_raise('AX412', 'transfer not found'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = o.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_amount := o.amount_minor;
    end if;
    -- Rutas afectadas (orden de id) y sus responsables releídos bajo bloqueo.
    perform 1 from adex.routes where company_id = v_company and id in (select j.route_id from adex.joint_reversal_routes(v_company, p_kind, p_target) j)
     order by id for share;
    if not exists (select 1 from adex.joint_reversal_routes(v_company, p_kind, p_target)) then perform adex.capital_raise('AX404', 'the operation has no route parts'); end if;
    if exists (select 1 from adex.joint_reversal_routes(v_company, p_kind, p_target) j where adex.route_valid_controller(v_company, j.route_id) is null) then
      perform adex.capital_raise('AX408', 'a route of the operation has no valid capital controller');
    end if;
    select array_agg(j.route_id order by j.route_id) filter (where adex.route_valid_controller(v_company, j.route_id) = v_actor),
           count(distinct adex.route_valid_controller(v_company, j.route_id))
      into v_mine, v_ctrls from adex.joint_reversal_routes(v_company, p_kind, p_target) j;
    if v_mine is null then perform adex.capital_raise('AX402', 'you are not the capital controller of any route of this operation'); end if;
    if v_ctrls = 1 then perform adex.capital_raise('AX440', 'you control every route of this operation: reverse it directly'); end if;

    insert into adex.joint_reversal_proposals (id, company_id, operation_id, target_kind, target_id, amount_minor, reason, proposed_by_membership_id, proposed_by_identity_id)
    values (v_id, v_company, p_operation_id, p_kind, p_target, v_amount, btrim(p_reason), v_actor, v_identity);
    insert into adex.joint_reversal_parts (id, company_id, proposal_id, route_id, amount_minor, direction, controller_membership_id,
                                           confirmed_at, confirmed_by_membership_id, confirm_operation_id)
    select gen_random_uuid()::text, v_company, v_id, j.route_id, j.amount_minor, j.direction, adex.route_valid_controller(v_company, j.route_id),
           case when j.route_id = any(v_mine) then now() end, case when j.route_id = any(v_mine) then v_actor end,
           case when j.route_id = any(v_mine) then p_operation_id end
      from adex.joint_reversal_routes(v_company, p_kind, p_target) j;
    insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
    values (gen_random_uuid()::text, v_company, v_id, p_operation_id, 'propose', v_mine, v_actor, v_identity, txid_current());
    return adex.joint_reversal_view(v_company, v_id);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'joint_reversal_proposals_one_pending' then perform adex.capital_raise('AX441', 'there is already a pending joint reversal for this operation'); end if;
      if v_cname in ('joint_reversal_proposals_operation_key', 'joint_reversal_events_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.joint_reversal_propose(uuid, text, text, text) from public;
grant execute on function adex.joint_reversal_propose(uuid, text, text, text) to adex_api;

-- CONFIRMAR. El responsable VIGENTE confirma SUS partes (todas las rutas afectadas de las que es responsable). Una
-- confirmación de quien ya no es el responsable deja de valer (se registra y el nuevo responsable confirma). Con la
-- última confirmación, la anulación COMPLETA se asienta aquí, en la misma transacción, con la función de anulación
-- de siempre (`expense_reverse`, `admin_reimbursement_reverse` o `route_base_post`) y el mismo id de operación:
-- todo o nada (periodo cerrado, fondos, ruta en entrega… revierten también la confirmación).
create function adex.joint_reversal_confirm(p_operation_id uuid, p_proposal text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    p          adex.joint_reversal_proposals;
    v_mine     text[];
    v_stale    text[];
    v_done     boolean;
    v_res      jsonb;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'joint reversals run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only a route capital controller confirms a joint reversal'); end if;
    if p_operation_id is null or p_proposal is null then perform adex.capital_raise('AX411', 'operation id and proposal are required'); end if;
    if exists (select 1 from adex.joint_reversal_events where company_id = v_company and operation_id = p_operation_id and event in ('propose', 'confirm', 'cancel')) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    -- Orden de bloqueo: propuesta → rutas (compartido) → lo que bloquee la función de anulación. Dos confirmaciones
    -- simultáneas se serializan aquí: exactamente una asienta.
    select * into p from adex.joint_reversal_proposals where company_id = v_company and id = p_proposal for update;
    if not found or not adex.joint_proposal_visible(v_company, p_proposal) then perform adex.capital_raise('AX412', 'proposal not found'); end if;
    if p.status <> 'pending' then perform adex.capital_raise('AX442', 'the joint reversal is no longer pending'); end if;
    if p.target_kind = 'expense' and not adex.ctx_can('expense.correct') then perform adex.capital_raise('42501', 'no expense correction authority'); end if;
    if p.target_kind = 'reimbursement' and not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no reimbursement authority'); end if;
    perform 1 from adex.routes where company_id = v_company and id in (select t.route_id from adex.joint_reversal_parts t where t.company_id = v_company and t.proposal_id = p.id)
     order by id for share;
    select array_agg(t.route_id::text order by t.route_id) into v_mine from adex.joint_reversal_parts t
     where t.company_id = v_company and t.proposal_id = p.id and adex.route_valid_controller(v_company, t.route_id) = v_actor
       and t.confirmed_by_membership_id is distinct from v_actor;
    if v_mine is null then
      if exists (select 1 from adex.joint_reversal_parts t where t.company_id = v_company and t.proposal_id = p.id
                   and adex.route_valid_controller(v_company, t.route_id) = v_actor) then
        perform adex.capital_raise('AX415', 'your part is already confirmed');
      end if;
      perform adex.capital_raise('AX402', 'you are not the capital controller of any route of this operation');
    end if;
    update adex.joint_reversal_parts set confirmed_at = now(), confirmed_by_membership_id = v_actor, confirm_operation_id = p_operation_id
     where company_id = v_company and proposal_id = p.id and route_id = any(v_mine);
    insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
    values (gen_random_uuid()::text, v_company, p.id, p_operation_id, 'confirm', v_mine, v_actor, v_identity, txid_current());
    -- Confirmaciones de quien ya no es el responsable vigente: dejan de valer.
    select array_agg(t.route_id::text order by t.route_id) into v_stale from adex.joint_reversal_parts t
     where t.company_id = v_company and t.proposal_id = p.id and t.confirmed_by_membership_id is not null
       and t.confirmed_by_membership_id is distinct from adex.route_valid_controller(v_company, t.route_id);
    if v_stale is not null then
      update adex.joint_reversal_parts set confirmed_at = null, confirmed_by_membership_id = null, confirm_operation_id = null
       where company_id = v_company and proposal_id = p.id and route_id = any(v_stale);
      insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
      values (gen_random_uuid()::text, v_company, p.id, null, 'confirmation_reset', v_stale, v_actor, v_identity, txid_current());
    end if;
    -- ¿La operación ya se anuló por otro camino (p. ej. alguien pasó a controlar todas las rutas)? La propuesta caduca.
    v_done := case p.target_kind
      when 'expense' then exists (select 1 from adex.expenses where company_id = v_company and id = p.target_id and reversal_id is not null)
      when 'reimbursement' then exists (select 1 from adex.admin_reimbursements where company_id = v_company and id = p.target_id and reversed_at is not null)
      else exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = p.target_id) end;
    if v_done then
      update adex.joint_reversal_proposals set status = 'obsolete', closed_at = now(), closed_by_membership_id = v_actor,
             close_reason = 'La operación ya estaba anulada' where company_id = v_company and id = p.id;
      insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
      values (gen_random_uuid()::text, v_company, p.id, null, 'obsolete', '{}', v_actor, v_identity, txid_current());
      return adex.joint_reversal_view(v_company, p.id);
    end if;
    if exists (select 1 from adex.joint_reversal_parts t where t.company_id = v_company and t.proposal_id = p.id and t.confirmed_by_membership_id is null) then
      return adex.joint_reversal_view(v_company, p.id);
    end if;
    -- Última confirmación: la anulación completa, aquí y ahora.
    perform set_config('adex.joint_posting', p.id, true);
    if p.target_kind = 'expense' then
      v_res := adex.expense_reverse(p_operation_id, p.target_id, p.reason);
    elsif p.target_kind = 'reimbursement' then
      v_res := adex.admin_reimbursement_reverse(p_operation_id, p.target_id, p.reason);
    else
      v_res := to_jsonb(adex.route_base_post(p_operation_id, 'REVERSAL', null, p.reason,
                                             (select route_id from adex.capital_operations where company_id = v_company and id = p.target_id), null, p.target_id));
    end if;
    perform set_config('adex.joint_posting', '', true);
    update adex.joint_reversal_proposals set status = 'posted', closed_at = now(), closed_by_membership_id = v_actor, posting_operation_id = p_operation_id,
           result = v_res where company_id = v_company and id = p.id;
    insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
    values (gen_random_uuid()::text, v_company, p.id, p_operation_id, 'post', '{}', v_actor, v_identity, txid_current());
    return adex.joint_reversal_view(v_company, p.id) || jsonb_build_object('posting', v_res);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'joint_reversal_events_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.joint_reversal_confirm(uuid, text) from public;
grant execute on function adex.joint_reversal_confirm(uuid, text) to adex_api;

-- CANCELAR. Quien propuso; si ya no es el responsable de ninguna ruta afectada, cualquier responsable vigente de
-- una ruta afectada (la propuesta no queda sin dueño). Nada se asienta.
create function adex.joint_reversal_cancel(p_operation_id uuid, p_proposal text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    p          adex.joint_reversal_proposals;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'joint reversals run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only the administrator who proposed cancels a joint reversal'); end if;
    if p_operation_id is null or p_proposal is null then perform adex.capital_raise('AX411', 'operation id and proposal are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if exists (select 1 from adex.joint_reversal_events where company_id = v_company and operation_id = p_operation_id and event in ('propose', 'confirm', 'cancel')) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    select * into p from adex.joint_reversal_proposals where company_id = v_company and id = p_proposal for update;
    if not found or not adex.joint_proposal_visible(v_company, p_proposal) then perform adex.capital_raise('AX412', 'proposal not found'); end if;
    if p.status <> 'pending' then perform adex.capital_raise('AX442', 'the joint reversal is no longer pending'); end if;
    if p.proposed_by_membership_id is distinct from v_actor
       and (exists (select 1 from adex.joint_reversal_parts t where t.company_id = v_company and t.proposal_id = p.id
                      and adex.route_valid_controller(v_company, t.route_id) is not distinct from p.proposed_by_membership_id)
            or not exists (select 1 from adex.joint_reversal_parts t where t.company_id = v_company and t.proposal_id = p.id
                             and adex.route_valid_controller(v_company, t.route_id) = v_actor)) then
      perform adex.capital_raise('AX402', 'only the administrator who proposed cancels a joint reversal');
    end if;
    update adex.joint_reversal_proposals set status = 'cancelled', closed_at = now(), closed_by_membership_id = v_actor, close_reason = btrim(p_reason)
     where company_id = v_company and id = p.id;
    insert into adex.joint_reversal_events (id, company_id, proposal_id, operation_id, event, route_ids, actor_membership_id, actor_identity_id, txid)
    values (gen_random_uuid()::text, v_company, p.id, p_operation_id, 'cancel', '{}', v_actor, v_identity, txid_current());
    return adex.joint_reversal_view(v_company, p.id);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'joint_reversal_events_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.joint_reversal_cancel(uuid, text, text) from public;
grant execute on function adex.joint_reversal_cancel(uuid, text, text) to adex_api;
