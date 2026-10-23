-- ============================================================
-- 0035 · Financiación de los gastos GENERALES (D74-O4F) · intervención R74
-- ============================================================
-- Decisiones del propietario (docs/ADEX_RONDA_74_INTERVENCION_INTEGRAL.md §13.2, 2026-10-23):
--   · ALCANCE (a quién beneficia) y FUENTE (qué cuenta pagó) son dimensiones independientes. Alcances:
--     `ruta` (ya existía), `administrador` (NUEVO: gasto general de UN Administrador que beneficia a
--     varias de sus rutas; guarda su membresía) y `empresa`. Cada gasto se registra UNA sola vez; sin
--     prorrateo automático, sin ruta pagadora arbitraria y sin que una ruta financie a otra en silencio.
--   · A  (gasto general del Administrador, `funding = 'routes'`): el Administrador elige de cuáles de SUS
--     rutas (donde es el responsable de capital válido) sale el dinero y cuánto aporta cada una; la suma
--     es el gasto. Sale de la Base de cada ruta (≥ 0, idempotente, atómico, auditado).
--   · C1 (gasto general de la empresa pagado con aportes de rutas): la misma mecánica con alcance
--     `empresa`. REGLA DEFINITIVA del propietario (2026-10-23): las rutas aportantes son SIEMPRE del
--     mismo Administrador que registra (donde es el responsable de capital válido); rutas de OTRO
--     Administrador NUNCA aportan (rechazado por el propietario, no es provisional). Igual en A y en los
--     reembolsos (quien paga controla las rutas aportantes). Regla única: `adex.general_contribution_route_allowed`.
--   · C2 (gasto general pagado por un Administrador con dinero propio, `funding = 'own_money'`): SIEMPRE
--     reembolsable y SIN aprobación (socios de confianza). Crea una obligación de la empresa con ese
--     Administrador: cuenta de pasivo `admin_payable` por membresía (con signo: negativo = la empresa
--     debe). Patas: gasto +X, admin_payable(A) −X. NUNCA es efectivo: no suma a ninguna Base, custodia
--     ni caja. Se corrige solo por anulación auditable. Disponible en AMBOS modelos de capital (no mueve
--     efectivo). Con alcance `administrador` también se admite (sugerencia del propietario: cuando sus
--     rutas no tienen Base; misma obligación, mismo reembolso).
--   · Reembolso: paga todo o parte del saldo pendiente de un Administrador con aportes explícitos de
--     rutas donde QUIEN PAGA es el responsable válido (route_base(R) −x, admin_payable(A) +x; el efectivo
--     sale hacia el Administrador). Nunca supera lo pendiente; idempotente; auditado; anulable por quien
--     pagó. En `admin_pool` (decisión técnica justificada): se paga desde la bolsa del Administrador que
--     paga (admin(P) −x, admin_payable(A) +x): es la cuenta de efectivo de ese modelo; sin esto las
--     obligaciones C2 de una empresa `admin_pool` no podrían saldarse hasta migrar.
--   · Resultados (O8): `route_panel` muestra los gastos generales del Administrador y de la empresa
--     APARTE del resultado operativo de las rutas, por naturaleza, y «reembolsos pendientes a
--     Administradores» (Σ admin_payable), nunca como efectivo.
--
-- DISEÑO DE LAS PATAS (por qué una operación por ruta): el guardián de ámbito de 0034
-- (`guard_route_base_entry`, AX424) exige que toda pata en una cuenta CON ruta sea de la ruta de la
-- operación. Un gasto con aportes de varias rutas NO puede ser una sola operación sin debilitar esa
-- barrera. Por eso cada aporte es una operación propia (`GENERAL_EXPENSE_CONTRIBUTION`, ruta = la que
-- aporta, patas route_base(R) −x y gasto sin ruta +x), todas enlazadas al MISMO gasto por `expense_id` y
-- registradas en `general_funding_contributions` (ruta, importe, operación). El índice «una operación por
-- gasto» (0013) se relaja SOLO para este tipo; el gasto sigue existiendo una sola vez. El reembolso usa
-- el mismo patrón (`ADMIN_REIMBURSEMENT`, una operación por ruta aportante). Los identificadores de
-- operación de los aportes 2..n se derivan del de la petición (idempotencia: el primero ES el de la
-- petición; repetirla devuelve AX409 en PostgreSQL y la misma respuesta en la API).
--
-- Aditiva: con `admin_pool` y sin usar los alcances/fuentes nuevos, cada función redefinida se comporta
-- EXACTAMENTE igual. No cambia ni borra filas. Generado por tmp/r74p/o4f/build-0035.mjs (copia literal de
-- la última definición de cada función con reemplazos exactos de una sola ocurrencia).

-- ============================================================
-- 1. Esquema
-- ============================================================

-- ---------- Cuenta de pasivo por Administrador (C2) ----------
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding', 'admin_payable'));
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
           -- C2: obligación de la empresa con UN Administrador (nunca de una ruta, nunca efectivo).
           when 'admin_payable' then membership_id is not null and route_id is null
         end);
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable') or balance_minor >= 0);
-- Con signo y nunca positiva: −saldo = lo que la empresa le debe. Un reembolso nunca la pasa de cero.
alter table adex.capital_accounts add constraint capital_accounts_admin_payable_sign check (kind <> 'admin_payable' or balance_minor <= 0);

-- ---------- Operaciones nuevas ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'));
alter table adex.capital_operations drop constraint capital_operations_expense_shape;
alter table adex.capital_operations add constraint capital_operations_expense_shape
  check ((coalesce(reverses_kind, kind) in ('WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
                                            'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY')) = (expense_id is not null));
-- Forma: el aporte es de UNA ruta y de su responsable; el gasto con dinero propio no tiene ruta; el
-- reembolso lleva quién paga (`admin_membership_id`) y a quién (`counterpart_membership_id`).
alter table adex.capital_operations add constraint capital_operations_general_funding_shape
  check ((coalesce(reverses_kind, kind) <> 'GENERAL_EXPENSE_CONTRIBUTION' or (route_id is not null and admin_membership_id is not null))
     and (coalesce(reverses_kind, kind) <> 'GENERAL_EXPENSE_OWN_MONEY' or (route_id is null and admin_membership_id is not null))
     and (coalesce(reverses_kind, kind) <> 'ADMIN_REIMBURSEMENT' or (admin_membership_id is not null and counterpart_membership_id is not null)));
-- «Un asiento por fila de gasto» (0013), salvo los aportes: varias operaciones (una por ruta) de UN gasto.
drop index adex.capital_operations_one_per_expense;
create unique index capital_operations_one_per_expense on adex.capital_operations (company_id, expense_id)
  where expense_id is not null and coalesce(reverses_kind, kind) <> 'GENERAL_EXPENSE_CONTRIBUTION';

-- ---------- Gastos: alcance `administrador`, fuentes `routes` y `own_money` ----------
alter table adex.expenses add column responsible_admin_membership_id adex.eid;
alter table adex.expenses add constraint expenses_responsible_admin_fk
  foreign key (company_id, responsible_admin_membership_id) references adex.memberships(company_id, id);
alter table adex.expenses drop constraint expenses_scope_check;
alter table adex.expenses add constraint expenses_scope_check check (scope in ('empresa', 'ruta', 'trabajador', 'administrador'));
alter table adex.expenses drop constraint expenses_funding_check;
alter table adex.expenses add constraint expenses_funding_check check (funding in ('admin', 'empresa', 'routes', 'own_money'));
-- Antes: «bolsa solo en gastos de empresa». Ahora la fuente también existe en el alcance `administrador`,
-- que SOLO se financia con aportes de sus rutas o con dinero propio (nunca bolsa ni cuenta de empresa).
alter table adex.expenses drop constraint expenses_check4;
alter table adex.expenses add constraint expenses_funding_scope_check
  check ((funding is null or scope in ('empresa', 'administrador'))
         and (scope is distinct from 'administrador' or (route_id is null and collector_membership_id is null and funding in ('routes', 'own_money'))));
-- El Administrador responsable existe exactamente en los gastos con las fuentes nuevas.
alter table adex.expenses add constraint expenses_responsible_admin_check
  check ((funding is not null and funding in ('routes', 'own_money')) = (responsible_admin_membership_id is not null));
create index expenses_responsible_admin on adex.expenses (company_id, responsible_admin_membership_id) where responsible_admin_membership_id is not null;

-- ---------- Reembolsos a Administradores ----------
create table adex.admin_reimbursements (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  operation_id               uuid not null,               -- X-Adex-Operation-Id de la petición
  admin_membership_id        adex.eid not null,           -- a quién se reembolsa (titular de admin_payable)
  payer_membership_id        adex.eid not null,           -- quién paga (responsable de las rutas aportantes)
  amount_minor               bigint not null check (amount_minor > 0),
  source                     text not null check (source in ('routes', 'admin_pool')),
  reason                     text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  entry_date                 date not null,
  actor_identity_id          uuid not null references adex.identities(id),
  txid                       bigint not null,
  created_at                 timestamptz not null default now(),
  reversed_at                timestamptz,
  reversed_by_membership_id  adex.eid,
  reversal_reason            text check (reversal_reason is null or (length(btrim(reversal_reason)) >= 3 and length(reversal_reason) <= 300)),
  reversal_operation_id      uuid,
  unique (company_id, id),
  constraint admin_reimbursements_operation_key unique (company_id, operation_id),
  constraint admin_reimbursements_reversal_key unique (company_id, reversal_operation_id),
  check ((reversed_at is null) = (reversed_by_membership_id is null) and (reversed_at is null) = (reversal_reason is null)
         and (reversed_at is null) = (reversal_operation_id is null)),
  foreign key (company_id, admin_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, payer_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id) references adex.memberships(company_id, id)
);
create index admin_reimbursements_admin on adex.admin_reimbursements (company_id, admin_membership_id, created_at);
-- Hechos inmutables: solo se registra (una vez) su anulación.
create function adex.guard_admin_reimbursement() returns trigger
  language plpgsql
  as $$ begin
    if tg_op = 'DELETE' then raise exception 'adex: reimbursements are never deleted' using errcode = '42501'; end if;
    if old.reversed_at is not null
       or (to_jsonb(new) - 'reversed_at' - 'reversed_by_membership_id' - 'reversal_reason' - 'reversal_operation_id')
          is distinct from (to_jsonb(old) - 'reversed_at' - 'reversed_by_membership_id' - 'reversal_reason' - 'reversal_operation_id') then
      raise exception 'adex: reimbursement % is immutable', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
revoke all on function adex.guard_admin_reimbursement() from public;
create trigger admin_reimbursements_guard before update or delete on adex.admin_reimbursements
  for each row execute function adex.guard_admin_reimbursement();
create trigger admin_reimbursements_no_truncate before truncate on adex.admin_reimbursements
  for each statement execute function adex.reject_mutation();

-- ---------- Aportes de rutas (A, C1 y reembolsos): uno por ruta, conciliable con el libro ----------
create table adex.general_funding_contributions (
  id                       adex.eid primary key,
  company_id               adex.eid not null references adex.companies(id),
  purpose                  text not null check (purpose in ('expense', 'reimbursement')),
  expense_id               adex.eid,
  reimbursement_id         adex.eid,
  route_id                 adex.eid,                     -- NULL solo en un reembolso desde la bolsa (admin_pool)
  amount_minor             bigint not null check (amount_minor > 0),
  operation_id             adex.eid not null,            -- la operación del libro de ESTE aporte
  controller_membership_id adex.eid not null,            -- responsable de la ruta que aportó (quien registró)
  created_at               timestamptz not null default now(),
  unique (company_id, id),
  constraint general_funding_contributions_operation_key unique (company_id, operation_id),
  constraint general_funding_contributions_expense_route_key unique (company_id, expense_id, route_id),
  constraint general_funding_contributions_reimbursement_route_key unique (company_id, reimbursement_id, route_id),
  check ((purpose = 'expense') = (expense_id is not null)),
  check ((purpose = 'reimbursement') = (reimbursement_id is not null)),
  check (purpose = 'reimbursement' or route_id is not null),
  foreign key (company_id, expense_id) references adex.expenses(company_id, id) deferrable initially deferred,
  foreign key (company_id, reimbursement_id) references adex.admin_reimbursements(company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, operation_id) references adex.capital_operations(company_id, id),
  foreign key (company_id, controller_membership_id) references adex.memberships(company_id, id)
);
create index general_funding_contributions_route on adex.general_funding_contributions (company_id, route_id, created_at);
do $$
begin
  execute 'create trigger general_funding_contributions_immutable before update or delete on adex.general_funding_contributions for each row execute function adex.reject_mutation()';
  execute 'create trigger general_funding_contributions_no_truncate before truncate on adex.general_funding_contributions for each statement execute function adex.reject_mutation()';
end $$;

-- ---------- Visibilidad (aditiva; las políticas existentes no cambian) ----------
alter table adex.admin_reimbursements enable row level security;
alter table adex.admin_reimbursements force row level security;
create policy owner_reimbursements_all on adex.admin_reimbursements for all to adex_owner using (true) with check (true);
create policy admin_reimbursements_ctx on adex.admin_reimbursements for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and ((select adex.ctx_role()) = 'superadmin' or adex.ctx_membership() in (admin_membership_id, payer_membership_id)));
grant select on adex.admin_reimbursements to adex_api;

alter table adex.general_funding_contributions enable row level security;
alter table adex.general_funding_contributions force row level security;
create policy owner_contributions_all on adex.general_funding_contributions for all to adex_owner using (true) with check (true);
create policy general_funding_contributions_ctx on adex.general_funding_contributions for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or controller_membership_id = adex.ctx_membership()
        or ((select adex.ctx_is(array['admin', 'supervisor'])) and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))
        or exists (select 1 from adex.admin_reimbursements r where r.company_id = general_funding_contributions.company_id
                     and r.id = general_funding_contributions.reimbursement_id and r.admin_membership_id = adex.ctx_membership())
        or exists (select 1 from adex.expenses x where x.company_id = general_funding_contributions.company_id
                     and x.id = general_funding_contributions.expense_id and x.responsible_admin_membership_id = adex.ctx_membership())));
grant select on adex.general_funding_contributions to adex_api;

-- Gastos generales propios del Administrador (alcance `administrador` o `empresa` con las fuentes nuevas).
create policy expenses_general_ctx on adex.expenses for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and route_id is null
         and (select adex.ctx_role()) = 'admin' and responsible_admin_membership_id = adex.ctx_membership());
-- Su propio saldo a favor (C2). El SuperAdmin ya ve todas las cuentas.
create policy capital_accounts_admin_payable_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and kind = 'admin_payable'
         and (select adex.ctx_role()) = 'admin' and membership_id = adex.ctx_membership());
-- Aportes y reembolsos: quien recibe el reembolso y quienes gestionan la ruta que aportó.
create policy capital_operations_general_funding_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and coalesce(reverses_kind, kind) in ('GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT')
         and (counterpart_membership_id = adex.ctx_membership()
              or ((select adex.ctx_is(array['admin', 'supervisor'])) and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));

-- ============================================================
-- 2. Ayudantes
-- ============================================================
-- REGLA DEFINITIVA (propietario, 2026-10-23): una ruta aporta a un gasto general (A o C1) o a un reembolso
-- SOLO si `p_actor` (quien registra o paga) es su responsable de capital VÁLIDO, en todos los alcances.
-- Los aportes de rutas de OTRO Administrador están RECHAZADOS por el propietario (no es un punto de cambio
-- pendiente). `p_scope` se conserva solo para trazabilidad del llamador; no abre excepciones.
create function adex.general_contribution_route_allowed(p_company text, p_route text, p_actor text, p_scope text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select p_actor is not null and adex.route_valid_controller(p_company, p_route) is not distinct from p_actor $$;
revoke all on function adex.general_contribution_route_allowed(text, text, text, text) from public;
grant execute on function adex.general_contribution_route_allowed(text, text, text, text) to adex_api;

-- Identificador de operación del aporte n (1 = el de la petición; 2..n derivados y deterministas).
create function adex.general_contribution_op_id(p_operation_id uuid, p_n int) returns uuid
  language sql immutable
  as $$ select case when p_n = 1 then p_operation_id else md5(p_operation_id::text || ':general-funding:' || p_n)::uuid end $$;
revoke all on function adex.general_contribution_op_id(uuid, int) from public;

-- Aportes pedidos: [{routeId, amountMinor}], 1..20, rutas distintas, importes enteros > 0. Devuelve las
-- filas ordenadas por ruta (orden de bloqueo estable) o lanza AX429.
create function adex.general_contributions_parse(p_contributions jsonb) returns table (n int, route_id text, amount_minor bigint)
  language plpgsql stable
  as $$
  declare v_len int;
  begin
    if p_contributions is null or jsonb_typeof(p_contributions) <> 'array' then
      perform adex.capital_raise('AX429', 'contributions must be a list of {routeId, amountMinor}');
    end if;
    v_len := jsonb_array_length(p_contributions);
    if v_len < 1 or v_len > 20 then perform adex.capital_raise('AX429', 'between 1 and 20 contributions'); end if;
    if exists (select 1 from jsonb_array_elements(p_contributions) e
                where jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'routeId') is distinct from 'string' or length(e->>'routeId') = 0
                   or jsonb_typeof(e->'amountMinor') is distinct from 'number' or (e->>'amountMinor') !~ '^[1-9][0-9]{0,15}$') then
      perform adex.capital_raise('AX429', 'each contribution needs routeId and a positive integer amountMinor');
    end if;
    if (select count(distinct e->>'routeId') from jsonb_array_elements(p_contributions) e) <> v_len then
      perform adex.capital_raise('AX429', 'a route contributes only once');
    end if;
    return query
      select (row_number() over (order by e->>'routeId'))::int, e->>'routeId', (e->>'amountMinor')::bigint
        from jsonb_array_elements(p_contributions) e order by e->>'routeId';
  end $$;
revoke all on function adex.general_contributions_parse(jsonb) from public;

-- ============================================================
-- 3. Funciones redefinidas (copia literal + cambios mínimos)
-- ============================================================

-- capital_lock_accounts: la de 0034_route_base.sql.
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding', 'admin_payable'], kind), id
      for update;
  end $$;

-- guard_route_base_entry: la de 0034_route_base.sql.
create or replace function adex.guard_route_base_entry() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_akind text; v_aroute text; v_okind text; v_orev text; v_oroute text; v_oto text; v_model text;
  begin
    select kind, route_id into v_akind, v_aroute from adex.capital_accounts where company_id = new.company_id and id = new.account_id;
    select kind, reverses_kind, route_id, to_route_id into v_okind, v_orev, v_oroute, v_oto
      from adex.capital_operations where company_id = new.company_id and id = new.operation_id;
    -- (1) Una ruta nunca consume dinero de otra: la pata en una cuenta CON ruta pertenece a la ruta de
    --     la operación o a su ruta de destino (transferencias y reasignaciones).
    if v_aroute is not null and v_aroute is distinct from v_oroute and v_aroute is distinct from v_oto then
      raise exception 'adex: a leg on a route account belongs to another route' using errcode = 'AX424';
    end if;
    -- (2) Modelo de capital.
    if v_akind in ('admin', 'company', 'transit', 'route_base', 'route_funding') then
      select capital_model into v_model from adex.companies where id = new.company_id;
      if v_model = 'route_base' then
        -- Bolsas: «sin asignar», solo salen hacia una ruta por el reparto confirmado (O3).
        if v_akind in ('company', 'transit') or (v_akind = 'admin' and not (v_okind = 'LEGACY_POOL_TO_ROUTE' and new.amount_minor < 0)) then
          raise exception 'adex: administrator pools and company capital do not move in the route base model' using errcode = 'AX421';
        end if;
      elsif v_akind in ('route_base', 'route_funding') then
        raise exception 'adex: the route base model is not active in this company' using errcode = 'AX428';
      elsif v_model = 'migrating' then
        raise exception 'adex: the capital model of the company is being migrated' using errcode = 'AX422';
      end if;
    end if;
    -- (3) En entrega (O5): ni inyección ni salidas de la Base salvo correcciones de cobros, devoluciones y cuadres.
    if v_akind = 'route_base'
       and (v_okind = 'ROUTE_BASE_INJECTION'
            or (new.amount_minor < 0 and (v_okind in ('WORKER_DELIVERY', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LOAN_DISBURSEMENT', 'ROUTE_EXPENSE',
                                                     'DISBURSEMENT_ADJUSTMENT', 'ROUTE_REASSIGNMENT',
                                                     -- R74 (0035): aportes a gastos generales y reembolsos a Administradores.
                                                     'GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT')
                                          or (v_okind = 'REVERSAL' and v_orev = 'ROUTE_BASE_INJECTION'))))
       and adex.route_in_handover(new.company_id, v_aroute) then
      raise exception 'adex: the route is being handed over to a new responsible: confirm the count first' using errcode = 'AX423';
    end if;
    return new;
  end $$;

-- expense_post: la de 0034_route_base.sql.
create or replace function adex.expense_post(
  p_operation_id  uuid,
  p_scope         text,
  p_route         text,
  p_worker        text,
  p_category      text,
  p_amount        bigint,
  p_description   text,
  p_reference     text,
  p_funding       text,      -- solo empresa: 'admin' | 'empresa'
  p_funding_admin text
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_ctrl    text;
    v_payer   text;
    v_expacc  text;
    v_kind    text;
    v_admin   text;
    v_expense text := gen_random_uuid()::text;
    v_op      text := gen_random_uuid()::text;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('expense.register') then perform adex.capital_raise('42501', 'no expense authority'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (p_description is not null and length(p_description) > 300) or (p_reference is not null and length(p_reference) > 120) then
      perform adex.capital_raise('AX411', 'text too long');
    end if;
    -- Forma (`expenseShapeError`).
    if p_scope is null or p_scope not in ('empresa', 'ruta', 'trabajador')
       or (p_scope = 'empresa' and (p_route is not null or p_worker is not null))
       or (p_scope = 'ruta' and (p_route is null or p_worker is not null))
       or (p_scope = 'trabajador' and (p_route is null or p_worker is null))
       or (p_scope <> 'empresa' and (p_funding is not null or p_funding_admin is not null)) then
      perform adex.capital_raise('AX411', 'invalid expense shape');
    end if;
    if not exists (select 1 from adex.expense_categories where company_id = x.company and id = p_category) then
      perform adex.capital_raise('AX711', 'category not found');
    end if;

    if p_scope = 'empresa' then
      if not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no company expense authority'); end if;
      -- R74 (0035, D74-O4F): con `route_base` un gasto GENERAL se financia con aportes explícitos de rutas o con
      -- dinero propio del Administrador (`adex.general_expense_post`); nunca con una bolsa ni con la cuenta de la
      -- empresa (ni se elige una ruta en silencio). Esta vía (bolsa / cuenta de empresa) sigue rechazada.
      if adex.company_capital_model(x.company) = 'route_base' then
        perform adex.capital_raise('AX426', 'in the route base model a general expense is funded by route contributions or by the administrator own money');
      end if;
      if p_description is null or length(btrim(p_description)) < 3 then perform adex.capital_raise('AX411', 'description is required'); end if;
      -- Bolsa (D10/D11): Administrador → solo la suya; SuperAdmin → la de la empresa o la de un Administrador activo.
      if x.role = 'admin' then
        if p_funding is distinct from 'admin' or p_funding_admin is distinct from x.actor then perform adex.capital_raise('AX712', 'an administrator pays only from their own pool'); end if;
      elsif x.role = 'superadmin' then
        if p_funding = 'empresa' and p_funding_admin is null then null;
        elsif p_funding = 'admin' and exists (select 1 from adex.memberships where company_id = x.company and id = p_funding_admin and role = 'admin' and status = 'activo') then null;
        else perform adex.capital_raise('AX712', 'invalid pool');
        end if;
      else
        perform adex.capital_raise('42501', 'no company expense authority');
      end if;
      v_kind := 'COMPANY_EXPENSE';
      v_admin := case when p_funding = 'admin' then p_funding_admin end;
      v_payer := case when p_funding = 'admin' then adex.capital_account_for(x.company, 'admin', p_funding_admin, null)
                      else adex.capital_account_for(x.company, 'company', null, null) end;
    else
      if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
        perform adex.capital_raise('AX412', 'route not found');
      end if;
      perform 1 from adex.routes where company_id = x.company and id = p_route for share;
      if not adex.route_operational(x.company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
      if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      v_ctrl := adex.route_valid_controller(x.company, p_route);
      if p_scope = 'ruta' then
        -- C1: la paga la bolsa del responsable; solo él la registra (`structural`).
        if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'no route cash authority'); end if;
        if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
        if x.actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller pays route expenses'); end if;
        v_kind := 'ROUTE_EXPENSE';
        v_admin := v_ctrl;
        -- R74 Base por Ruta (0034): con `route_base` lo paga la Base de la ruta.
        v_payer := adex.route_cash_account(x.company, p_route, v_ctrl);
      else
        if not adex.capital_custodian_ok(x.company, p_route, p_worker) then perform adex.capital_raise('AX403', 'the worker cannot answer for an expense in this route'); end if;
        -- Cargarlo a OTRA persona es operar con su efectivo (`settle`).
        if p_worker is distinct from x.actor then
          if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'expenses you register are yours'); end if;
          if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
          if not (x.actor is not distinct from v_ctrl
                  or (x.role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = x.actor and route_id = p_route))) then
            perform adex.capital_raise('AX402', 'no authority over cash in this route');
          end if;
        end if;
        v_kind := 'WORKER_EXPENSE';
        v_payer := adex.capital_account_for(x.company, 'custody', p_worker, p_route);
      end if;
    end if;
    v_expacc := adex.capital_account_for(x.company, 'expense', null, p_route);
    perform adex.capital_lock_accounts(x.company, array[v_payer, v_expacc]);

    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, reference, sync_status, created_at, ledger_operation_id)
    values (v_expense, x.company, p_route, p_scope, p_category, p_amount, nullif(btrim(p_description), ''), x.today, x.actor, p_worker,
            case when p_scope = 'empresa' then p_funding end, case when p_scope = 'empresa' then p_funding_admin end,
            nullif(btrim(p_reference), ''), 'synced', now(), v_op);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, v_kind, p_amount, x.currency, p_route, v_admin, p_worker, v_expense,
            case when length(btrim(coalesce(p_description, ''))) >= 3 then btrim(p_description) else 'Gasto' end,
            x.today, x.actor, x.identity, x.role, txid_current());
    -- Gasto del trabajador SIN tope (73209ce): `guard_custody_negative` admite su negativo.
    perform adex.capital_write_legs(x.company, v_op, array[v_payer, v_expacc], array[-p_amount, p_amount]);
    return jsonb_build_object('expenseId', v_expense, 'operationId', v_op, 'kind', v_kind, 'expenseDate', x.today);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- expense_correctable: la de 0034_route_base.sql.
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
      if x.role is distinct from 'admin' or e.responsible_admin_membership_id is distinct from x.actor then
        perform adex.capital_raise('AX402', 'only the administrator responsible for the general expense reverses it');
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

-- expense_reverse: la de 0013_collections_expenses.sql.
create or replace function adex.expense_reverse(p_operation_id uuid, p_expense text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare x adex.money_ctx; c adex.expense_fix; v_rev text := gen_random_uuid()::text; v_op text := gen_random_uuid()::text; v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 200 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    c := adex.expense_correctable(x, p_expense, false);
    -- R74 (0035, D74-O4F): aportes de rutas (una anulación por aporte, a la Base de cada ruta) o dinero propio
    -- (la obligación con el Administrador se reduce).
    if c.kind in ('GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY') then
      return adex.general_expense_reverse(x, p_operation_id, c.id, btrim(p_reason));
    end if;
    -- D12: con reintegros previos se reintegra el resto; no se anula.
    if c.refunded > 0 then perform adex.capital_raise('AX715', 'the expense has refunds: refund the rest instead'); end if;
    perform adex.capital_lock_accounts(x.company, array[c.payer, c.expacc]);
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, sync_status, created_at, reverses_id, reversal_reason,
                               ledger_operation_id)
    select v_rev, company_id, route_id, scope, category_id, -amount_minor, 'Anulación: ' || btrim(p_reason), x.today, x.actor,
           collector_membership_id, funding, funding_admin_membership_id, 'synced', now(), id, btrim(p_reason), v_op
      from adex.expenses where company_id = x.company and id = c.id;
    update adex.expenses set reversal_id = v_rev, reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = btrim(p_reason)
     where company_id = x.company and id = c.id;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, expense_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', c.amount, x.currency, c.route, c.admin, c.worker, v_rev, c.op, c.kind, btrim(p_reason),
            x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[c.payer, c.expacc], array[c.amount::bigint, -c.amount::bigint]);
    return jsonb_build_object('reversalExpenseId', v_rev, 'operationId', v_op, 'expenseId', c.id, 'amountMinor', c.amount, 'reversalDate', x.today,
      'periodClosed', c.route is not null and adex.capital_period_closed(x.company, c.route,
                        (select expense_date from adex.expenses where company_id = x.company and id = c.id)));
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'expenses_company_id_reverses_id_key') then perform adex.capital_raise('AX405', 'expense already reversed'); end if;
      raise;
  end $$;

-- capital_ledger_checks: la de 0034_route_base.sql.
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
                          and a.carried_minor <> coalesce((select s.carried_after_minor from adex.custody_settlements s where s.company_id = a.company_id
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
                          and abs(a.balance_minor) <> coalesce((select sum(s.surplus_minor) from adex.custody_settlements s where s.company_id = a.company_id
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
                                                  and r.admin_membership_id = m.id and r.reversed_at is null), 0)))
      into r;
    return r;
  end $$;

-- capital_model_prerequisites: la de 0034_route_base.sql.
create or replace function adex.capital_model_prerequisites() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_company_bal bigint; v_transit bigint; v_pending_transfers int; v_pending_requests int; v_routes text[]; v_ledger jsonb;
    v_overdrawn int; v_conservation numeric; v_pools jsonb; v_checks jsonb;
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
     where company_id = v_company and kind not in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable') and balance_minor < 0;
    select coalesce(sum(balance_minor), 0) into v_conservation from adex.capital_accounts where company_id = v_company;
    select coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'status', m.status, 'balanceMinor', a.balance_minor)
                    order by m.display_name, a.membership_id), '[]'::jsonb)
      into v_pools
      from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin' and a.balance_minor <> 0;
    v_checks := jsonb_build_array(
      jsonb_build_object('name', 'company-account-zero', 'ok', v_company_bal = 0, 'detail', v_company_bal, 'documentable', true),
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

-- route_panel: la de 0034_route_base.sql.
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
      v_alerts := array_remove(array[
        case when not r.ctrl_valid then 'NO_VALID_CONTROLLER' end,
        case when r.handover_state = 'en_entrega' then 'ROUTE_IN_HANDOVER' end,
        case when (v_handover->>'status') = 'confirmada' and coalesce((v_handover->>'difference_minor')::bigint, 0) <> 0 then 'HANDOVER_DIFFERENCE' end,
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
                  'pendingAdminReimbursementsMinor', coalesce((v_payables->>'totalMinor')::bigint, 0)));
  end $$;


-- ============================================================
-- 4. Comandos nuevos
-- ============================================================

-- ---------- Gasto general con aportes de rutas (A, C1) o con dinero propio (C2) ----------
-- Solo el Administrador (el SuperAdmin nunca mueve dinero; Secretario, Supervisor y Cobrador no).
--   funding = 'routes':    solo con `route_base`; cada aporte sale de la Base de una ruta donde el actor es
--                          el responsable VÁLIDO (punto de cambio C1: general_contribution_route_allowed);
--                          suma de aportes = gasto; si una Base no alcanza, NADA se escribe (AX401).
--   funding = 'own_money': ambos modelos; gasto +X y admin_payable(actor) −X; nunca efectivo.
create function adex.general_expense_post(
  p_operation_id  uuid,
  p_scope         text,
  p_category      text,
  p_amount        bigint,
  p_description   text,
  p_reference     text,
  p_funding       text,
  p_contributions jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_model   text;
    v_expense text := gen_random_uuid()::text;
    v_expacc  text;
    v_payable text;
    v_first   text;
    v_op      text;
    v_ctrl    text;
    v_accts   text[] := '{}';
    v_ops     jsonb := '[]'::jsonb;
    v_contrib jsonb := '[]'::jsonb;
    v_sum     bigint;
    v_reason  text;
    c         record;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then
      perform adex.capital_raise('AX402', 'only an administrator registers general expenses funded by routes or by their own money');
    end if;
    if not adex.ctx_can('expense.register') or not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no general expense authority'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if p_description is null or length(btrim(p_description)) < 3 or length(p_description) > 300 then perform adex.capital_raise('AX411', 'description is required'); end if;
    if p_reference is not null and length(p_reference) > 120 then perform adex.capital_raise('AX411', 'text too long'); end if;
    if p_scope is null or p_scope not in ('administrador', 'empresa') or p_funding is null or p_funding not in ('routes', 'own_money')
       or (p_funding = 'own_money' and p_contributions is not null and p_contributions <> 'null'::jsonb) then
      perform adex.capital_raise('AX411', 'invalid general expense shape');
    end if;
    if not exists (select 1 from adex.expense_categories where company_id = x.company and id = p_category) then
      perform adex.capital_raise('AX711', 'category not found');
    end if;
    v_model := adex.company_capital_model(x.company);
    v_expacc := adex.capital_account_for(x.company, 'expense', null, null);
    v_reason := left('Gasto general: ' || btrim(p_description), 300);

    if p_funding = 'routes' then
      if v_model is distinct from 'route_base' then
        perform adex.capital_raise('AX428', 'route contributions need the route base model: use own money in this company');
      end if;
      select coalesce(sum(amount_minor), 0) into v_sum from adex.general_contributions_parse(p_contributions);
      if v_sum <> p_amount then perform adex.capital_raise('AX429', 'the contributions must add up to the expense'); end if;
      -- Rutas en orden de id, bloqueadas (el responsable no cambia a mitad del comando) y validadas.
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        if not adex.ctx_route_allowed(c.route_id) or not exists (select 1 from adex.routes where company_id = x.company and id = c.route_id) then
          perform adex.capital_raise('AX412', 'route not found');
        end if;
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.route_operational(x.company, c.route_id) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        v_ctrl := adex.route_valid_controller(x.company, c.route_id);
        if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, p_scope) then
          perform adex.capital_raise('AX430', 'a route contributes only when you are its capital controller');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        if adex.route_in_handover(x.company, c.route_id) then
          perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
        end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end loop;
      perform adex.capital_lock_accounts(x.company, v_accts || v_expacc);
      v_first := gen_random_uuid()::text;
      insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                                 collector_membership_id, funding, funding_admin_membership_id, responsible_admin_membership_id, reference, sync_status,
                                 created_at, ledger_operation_id)
      values (v_expense, x.company, null, p_scope, p_category, p_amount, btrim(p_description), x.today, x.actor, null, 'routes', null, x.actor,
              nullif(btrim(p_reference), ''), 'synced', now(), v_first);
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        v_op := case when c.n = 1 then v_first else gen_random_uuid()::text end;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, c.n), 'GENERAL_EXPENSE_CONTRIBUTION', c.amount_minor, x.currency,
                c.route_id, x.actor, v_expense, v_reason, x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_expacc],
                                        array[-c.amount_minor, c.amount_minor]);
        insert into adex.general_funding_contributions (id, company_id, purpose, expense_id, route_id, amount_minor, operation_id, controller_membership_id)
        values (gen_random_uuid()::text, x.company, 'expense', v_expense, c.route_id, c.amount_minor, v_op, x.actor);
        v_ops := v_ops || to_jsonb(v_op);
        v_contrib := v_contrib || jsonb_build_object('routeId', c.route_id, 'amountMinor', c.amount_minor, 'operationId', v_op);
      end loop;
      return jsonb_build_object('expenseId', v_expense, 'operationId', v_first, 'operationIds', v_ops, 'kind', 'GENERAL_EXPENSE_CONTRIBUTION',
                                'expenseDate', x.today, 'funding', 'routes', 'contributions', v_contrib);
    end if;

    -- C2 · dinero propio: obligación de la empresa con el actor; ningún efectivo se mueve.
    -- También con 'migrating': no toca bolsas, Bases ni la cuenta de la empresa.
    v_payable := adex.capital_account_for(x.company, 'admin_payable', x.actor, null);
    perform adex.capital_lock_accounts(x.company, array[v_payable, v_expacc]);
    v_op := gen_random_uuid()::text;
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, responsible_admin_membership_id, reference, sync_status,
                               created_at, ledger_operation_id)
    values (v_expense, x.company, null, p_scope, p_category, p_amount, btrim(p_description), x.today, x.actor, null, 'own_money', null, x.actor,
            nullif(btrim(p_reference), ''), 'synced', now(), v_op);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'GENERAL_EXPENSE_OWN_MONEY', p_amount, x.currency, null, x.actor, v_expense, v_reason, x.today,
            x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_payable, v_expacc], array[-p_amount, p_amount]);
    return jsonb_build_object('expenseId', v_expense, 'operationId', v_op, 'operationIds', jsonb_build_array(v_op), 'kind', 'GENERAL_EXPENSE_OWN_MONEY',
                              'expenseDate', x.today, 'funding', 'own_money', 'contributions', '[]'::jsonb,
                              'pendingMinor', -(select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable));
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- Sin cifras: nunca revela el saldo de la Base de una ruta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.general_expense_post(uuid, text, text, bigint, text, text, text, jsonb) from public;
grant execute on function adex.general_expense_post(uuid, text, text, bigint, text, text, text, jsonb) to adex_api;

-- ---------- Anulación de un gasto general con las fuentes nuevas (desde `expense_reverse`) ----------
-- Autoridad ya comprobada por `expense_correctable` (solo el Administrador responsable del gasto).
--   own_money: gasto −X, admin_payable +X (la obligación vuelve a ser la de antes). Si ya se reembolsó
--              más de lo que quedaría pendiente, se NIEGA (AX432): primero se anula el reembolso.
--   routes:    una anulación por aporte; cada importe vuelve a la Base de SU ruta. Exige que el actor siga
--              siendo el responsable válido de cada ruta (AX430) y que su periodo de hoy esté abierto.
create function adex.general_expense_reverse(x adex.money_ctx, p_operation_id uuid, p_expense text, p_reason text) returns jsonb
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
      if (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable) + e.amount_minor > 0 then
        perform adex.capital_raise('AX432', 'the obligation was already reimbursed: reverse the reimbursement first');
      end if;
      v_first := gen_random_uuid()::text;
    else
      for c in select g.route_id from adex.general_funding_contributions g
                where g.company_id = x.company and g.expense_id = e.id order by g.route_id loop
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, e.scope) then
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
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id, x.actor, v_rev,
                c.operation_id, 'GENERAL_EXPENSE_CONTRIBUTION', p_reason, x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_expacc],
                                        array[c.amount_minor, -c.amount_minor]);
        v_ops := v_ops || to_jsonb(v_op);
      end loop;
    end if;
    return jsonb_build_object('reversalExpenseId', v_rev, 'operationId', v_first, 'operationIds', v_ops, 'expenseId', e.id, 'amountMinor', e.amount_minor,
                              'reversalDate', x.today, 'periodClosed', false);
  end $$;
revoke all on function adex.general_expense_reverse(adex.money_ctx, uuid, text, text) from public;

-- ---------- Reembolso a un Administrador (C2) ----------
--   route_base: aportes explícitos de rutas donde QUIEN PAGA es el responsable válido;
--               route_base(R) −x, admin_payable(A) +x por cada ruta.
--   admin_pool: desde la bolsa de quien paga; admin(P) −x, admin_payable(A) +x (`p_amount`, sin aportes).
-- Nunca más que lo pendiente (AX431, comprobado con la cuenta bloqueada: dos reembolsos simultáneos que
-- juntos lo superan → exactamente uno). Quien paga puede ser el propio Administrador (con sus rutas).
create function adex.admin_reimbursement_post(p_operation_id uuid, p_admin text, p_amount bigint, p_contributions jsonb, p_reason text) returns jsonb
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
  begin
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

    insert into adex.admin_reimbursements (id, company_id, operation_id, admin_membership_id, payer_membership_id, amount_minor, source, reason, entry_date,
                                           actor_identity_id, txid)
    values (v_id, x.company, p_operation_id, p_admin, x.actor, v_total, case when v_pool is null then 'routes' else 'admin_pool' end, btrim(p_reason), x.today,
            x.identity, txid_current());
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
                              'source', case when v_pool is null then 'routes' else 'admin_pool' end);
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
revoke all on function adex.admin_reimbursement_post(uuid, text, bigint, jsonb, text) from public;
grant execute on function adex.admin_reimbursement_post(uuid, text, bigint, jsonb, text) to adex_api;

-- Anulación de un reembolso registrado por error: solo quien pagó, siempre que siga siendo el
-- responsable válido de cada ruta aportante (el dinero vuelve a cada Base) y con el periodo abierto.
-- La obligación vuelve a quedar pendiente (admin_payable −x).
create function adex.admin_reimbursement_reverse(p_operation_id uuid, p_reimbursement text, p_reason text) returns jsonb
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
    if r.payer_membership_id is distinct from x.actor then perform adex.capital_raise('AX402', 'only the administrator who paid reverses a reimbursement'); end if;
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
revoke all on function adex.admin_reimbursement_reverse(uuid, text, text) from public;
grant execute on function adex.admin_reimbursement_reverse(uuid, text, text) to adex_api;

-- ---------- Saldos a favor de los Administradores (lectura; nunca efectivo) ----------
-- SECURITY INVOKER: el SuperAdmin ve todos; el Administrador, el suyo.
create function adex.admin_payables() returns table (admin_id text, name text, status text, pending_minor bigint, own_money_expenses_minor bigint,
                                                     reimbursed_minor bigint, last_movement_at timestamptz)
  language sql stable set search_path = pg_catalog, adex
  as $$
    with who as (
      select membership_id m from adex.capital_accounts where company_id = adex.ctx_company() and kind = 'admin_payable'
      union select responsible_admin_membership_id from adex.expenses where company_id = adex.ctx_company() and funding = 'own_money'
      union select admin_membership_id from adex.admin_reimbursements where company_id = adex.ctx_company()
    )
    select w.m::text, mb.display_name, mb.status,
           coalesce(-(select a.balance_minor from adex.capital_accounts a where a.company_id = adex.ctx_company() and a.kind = 'admin_payable' and a.membership_id = w.m), 0)::bigint,
           coalesce((select sum(x.amount_minor) from adex.expenses x where x.company_id = adex.ctx_company() and x.funding = 'own_money'
                       and x.responsible_admin_membership_id = w.m and x.ledger_operation_id is not null), 0)::bigint,
           coalesce((select sum(r.amount_minor) from adex.admin_reimbursements r where r.company_id = adex.ctx_company() and r.admin_membership_id = w.m
                       and r.reversed_at is null), 0)::bigint,
           (select max(a.updated_at) from adex.capital_accounts a where a.company_id = adex.ctx_company() and a.kind = 'admin_payable' and a.membership_id = w.m)
      from who w join adex.memberships mb on mb.company_id = adex.ctx_company() and mb.id = w.m
     where w.m is not null and (adex.ctx_role() = 'superadmin' or w.m = adex.ctx_membership())
     order by mb.display_name, w.m
  $$;
revoke all on function adex.admin_payables() from public;
grant execute on function adex.admin_payables() to adex_api;
