-- ============================================================
-- ADEX SaaS · Fase 5 · 0013 · Recaudos y gastos centralizados
-- ------------------------------------------------------------
-- Autorizada por el propietario (Fase 5, 2026-10-17). Solo en línea (DS-07): el
-- servidor confirma cada movimiento; no hay libro local paralelo.
--
-- Mismo motor que las Fases 3–4 (Empresa → bolsa del Administrador → custodia del
-- trabajador por ruta, sin caja de ruta). Reglas de CLEAN conservadas:
--
-- RECAUDO (`paymentService.registerPayment`): solo efectivo (CLEAN no crea otro tipo
-- desde ninguna pantalla); crédito activo, desembolsado y con cuotas; TOPE AL SALDO
-- (se guarda lo aplicado, nunca lo pedido; sin saldo a favor); cascada por número de
-- cuota (`applyPaymentToInstallments`); quien tiene caja personal responde por lo que
-- registra (`resolveResponsibleCollector`); el cobro que no entra a ninguna caja
-- personal (Administrador sin cobradores en la ruta) va a la bolsa del responsable
-- (C1, `COBRO_NO_PERSONAL`). Un cobro recibido por un trabajador NUNCA sube una bolsa.
--   Asiento COLLECTION: receptor +X · cartera de la ruta −capital · interés −resto.
--   El capital se reconoce en la proporción capital/total del crédito (la misma que
--   CLEAN usa para estimar el interés por cobrar, `cashboxEngine`), acumulada: tras
--   cobrar P, capital reconocido = round(P × capital / total). Al saldar, la cartera
--   del crédito queda exactamente en 0. El interés solo existe como dinero cuando se
--   cobra (Fase 4): su contrapartida es la cuenta `income` de la ruta.
--
-- GASTO (`expenseService.createExpense`, D9–D12, C1):
--   · trabajador → su custodia en la ruta. SIN tope de efectivo (73209ce): la custodia
--     PUEDE quedar negativa, y SOLO por este tipo de operación. Ningún otro débito
--     (devolución, traspaso, desembolso, anulación) la deja bajo cero, así que un
--     negativo nunca es efectivo entregable, desembolsable ni transferible. Es la
--     posición del ciclo («Mi efectivo»): los cobros siguientes la compensan, como en
--     CLEAN; el cuadre (Fase 6) lo concilia (decisión de reembolso abierta).
--   · ruta → la bolsa del Administrador responsable (C1, `GASTO_RUTA`), sin negativos.
--   · empresa → la bolsa elegida (Administrador: la suya; SuperAdmin: la de la empresa,
--     D10, o la de un Administrador activo, D11), sin negativos.
--   Fuente financiera (cuenta que paga) ≠ atribución (ruta, trabajador, categoría): la
--   ruta de un gasto es atribución; la cuenta `expense` acumula el gasto por ruta (o de
--   empresa) y no es una caja.
--
-- CORRECCIONES (asientos nuevos; lo cerrado no cambia, D7):
--   · anulación de un recaudo (`annulPayment`): `payment.reverse`; si su semana está
--     cerrada, la fecha va a hoy (6C.1) y exige `payment.approveAdjustment`; el receptor
--     debe conservar ese efectivo (nunca se devuelve dinero ya usado); recálculo canónico.
--   · gastos de bolsa (D12): anulación total (sin reintegros previos) o reintegros
--     parciales hasta lo no reintegrado.
--   · gastos de ruta o de trabajador (F5-D02, aprobada): anulación total por el
--     Administrador responsable de la ruta o el SuperAdmin, nunca por la PERSONA que lo
--     registró (aunque use otra membresía); hoy debe estar abierto y, si la semana del
--     gasto está cerrada, exige la autoridad de aprobar ajustes. El importe vuelve a la
--     cuenta que pagó (custodia del trabajador o bolsa que lo financió).
--   · reparto capital/interés: proporcional acumulado (F5-D01, aprobada; clasificación
--     interna del SaaS, no política fiscal o contable legal).
--
-- Escritura ÚNICAMENTE por funciones SECURITY DEFINER (solo `adex_api`); la API no
-- tiene INSERT/UPDATE en pagos, gastos, créditos ni cuotas. Orden global de bloqueos:
-- consultivos de REVOKE-004 → ruta (FOR SHARE: fija responsable y cierres, deja correr
-- otros recaudos de la ruta) → crédito o gasto (FOR UPDATE) → pago → cuentas (empresa
-- → bolsas → custodias → cartera → socios → externa → interés → gasto).
-- ============================================================

-- ============================================================
-- 1. Libro: cuentas de resultado y custodia negativa por gastos
-- ============================================================
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'partner', 'portfolio', 'income', 'expense'));
alter table adex.capital_accounts drop constraint capital_accounts_shape_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check
  check (case kind
           when 'company'   then membership_id is null and route_id is null
           when 'external'  then membership_id is null and route_id is null
           when 'admin'     then membership_id is not null and route_id is null
           when 'partner'   then membership_id is not null and route_id is null
           when 'custody'   then membership_id is not null and route_id is not null
           when 'portfolio' then membership_id is null and route_id is not null
           -- Interés cobrado de la ruta (contrapartida: mide lo ganado, nunca positivo).
           when 'income'    then membership_id is null and route_id is not null
           -- Gastos acumulados (por ruta o de empresa). Atribución, no caja.
           when 'expense'   then membership_id is null
         end);
-- La custodia deja de estar en el CHECK: su barrera es `guard_custody_negative`, que
-- solo admite el negativo producido por un gasto del trabajador.
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'partner', 'income', 'custody') or balance_minor >= 0);
alter table adex.capital_accounts add constraint capital_accounts_income_sign check (kind <> 'income' or balance_minor <= 0);

create function adex.guard_custody_negative() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$ begin
    if new.amount_minor < 0 and new.balance_after_minor < 0
       and exists (select 1 from adex.capital_accounts a where a.company_id = new.company_id and a.id = new.account_id and a.kind = 'custody')
       and not exists (select 1 from adex.capital_operations o where o.company_id = new.company_id and o.id = new.operation_id and o.kind = 'WORKER_EXPENSE') then
      -- Mismo nombre de restricción que el sobregiro: las funciones lo informan sin cifras.
      raise exception 'adex: custody goes negative only by a worker expense' using errcode = '23514', constraint = 'capital_accounts_no_overdraft';
    end if;
    return new;
  end $$;
create trigger capital_entries_custody_negative before insert on adex.capital_entries
  for each row execute function adex.guard_custody_negative();

-- ---------- Operaciones nuevas ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND'));
do $$
declare c text;
begin
  select conname into strict c from pg_constraint
   where conrelid = 'adex.capital_operations'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%(reverses_kind IS NULL)%';
  execute format('alter table adex.capital_operations drop constraint %I', c);
end $$;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION',
                                                   'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT',
                                                   'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE'));
-- El Cobrador registra sus cobros y sus gastos (y desembolsa, Fase 4); nada más.
alter table adex.capital_operations drop constraint capital_operations_actor_role_check;
alter table adex.capital_operations add constraint capital_operations_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor')
         or (actor_role = 'cobrador' and kind in ('LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE')));

alter table adex.capital_operations add column payment_id adex.eid, add column expense_id adex.eid;
alter table adex.capital_operations add constraint capital_operations_payment_fk
  foreign key (company_id, payment_id) references adex.payments(company_id, id) deferrable initially deferred;
alter table adex.capital_operations add constraint capital_operations_expense_fk
  foreign key (company_id, expense_id) references adex.expenses(company_id, id) deferrable initially deferred;
-- Un asiento por fila de pago o de gasto (original, anulación o reintegro).
create unique index capital_operations_one_per_payment on adex.capital_operations (company_id, payment_id) where payment_id is not null;
create unique index capital_operations_one_per_expense on adex.capital_operations (company_id, expense_id) where expense_id is not null;
alter table adex.capital_operations drop constraint capital_operations_disbursement_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION')) = (sale_id is not null));
alter table adex.capital_operations add constraint capital_operations_payment_shape
  check ((coalesce(reverses_kind, kind) = 'COLLECTION') = (payment_id is not null));
alter table adex.capital_operations add constraint capital_operations_expense_shape
  check ((coalesce(reverses_kind, kind) in ('WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND')) = (expense_id is not null));

-- ============================================================
-- 2. Pagos y gastos: enlace con su asiento
-- ============================================================
alter table adex.payments
  add column ledger_operation_id adex.eid,
  add column principal_minor bigint,
  add column interest_minor bigint;
alter table adex.payments add constraint payments_ledger_operation_fk
  foreign key (company_id, ledger_operation_id) references adex.capital_operations(company_id, id) deferrable initially deferred;
create unique index payments_ledger_operation_key on adex.payments (company_id, ledger_operation_id) where ledger_operation_id is not null;
-- Reparto capital/interés: solo en pagos con asiento, suma el importe y lleva su signo.
alter table adex.payments add constraint payments_ledger_split_shape
  check ((ledger_operation_id is null) = (principal_minor is null) and (principal_minor is null) = (interest_minor is null)
         and (principal_minor is null or (principal_minor + interest_minor = amount_minor
              and ((amount_minor > 0 and principal_minor >= 0 and interest_minor >= 0)
                   or (amount_minor < 0 and principal_minor <= 0 and interest_minor <= 0)))));

alter table adex.expenses add column ledger_operation_id adex.eid;
alter table adex.expenses add constraint expenses_ledger_operation_fk
  foreign key (company_id, ledger_operation_id) references adex.capital_operations(company_id, id) deferrable initially deferred;
create unique index expenses_ledger_operation_key on adex.expenses (company_id, ledger_operation_id) where ledger_operation_id is not null;

-- La API nunca crea un pago o gasto sin asiento (los sembrados o importados no pasan por aquí).
create function adex.ledger_row_server_guard() returns trigger
  language plpgsql
  as $$ begin
    if session_user = 'adex_api' and new.ledger_operation_id is null then
      raise exception 'adex: % rows are created only with their ledger entry', tg_table_name using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger payments_server_guard before insert on adex.payments for each row execute function adex.ledger_row_server_guard();
create trigger expenses_server_guard before insert on adex.expenses for each row execute function adex.ledger_row_server_guard();

-- El enlace y el reparto de un pago son hechos (la transición de estado ya la vigila 0002).
create function adex.guard_payment_ledger_facts() returns trigger
  language plpgsql
  as $$ begin
    if (new.ledger_operation_id, new.principal_minor, new.interest_minor) is distinct from (old.ledger_operation_id, old.principal_minor, old.interest_minor) then
      raise exception 'adex: payment % ledger facts are immutable', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger payments_ledger_facts before update on adex.payments for each row execute function adex.guard_payment_ledger_facts();

-- Escritura del propietario (solo desde las funciones de este archivo).
create policy owner_collection_insert on adex.payments for insert to adex_owner with check (true);
create policy owner_collection_update on adex.payments for update to adex_owner using (true) with check (true);
create policy owner_credit_update on adex.sales for update to adex_owner using (true) with check (true);
create policy owner_credit_update on adex.installments for update to adex_owner using (true) with check (true);
create policy owner_expense_insert on adex.expenses for insert to adex_owner with check (true);
create policy owner_expense_update on adex.expenses for update to adex_owner using (true) with check (true);

-- ============================================================
-- 3. Visibilidad
-- ============================================================
-- Gastos (`listVisibleExpenses` de CLEAN, más estricto con el Cobrador, como el resto
-- de la Fase 3): de ruta, quien gestiona la ruta; cualquiera, los suyos (a su cargo o
-- registrados por él); de empresa, el SuperAdmin y el Administrador de ESA bolsa.
drop policy expenses_ctx on adex.expenses;
create policy expenses_ctx on adex.expenses for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or (route_id is not null and adex.ctx_is(array['admin', 'supervisor', 'socio']) and adex.ctx_route_allowed(route_id))
        or (route_id is not null and adex.ctx_route_allowed(route_id)
            and adex.ctx_membership() in (collector_membership_id, registered_by_membership_id))
        or (route_id is null and adex.ctx_role() = 'admin'
            and (funding_admin_membership_id = adex.ctx_membership()
                 or (funding is null and registered_by_membership_id = adex.ctx_membership())))));

-- Operaciones: amplía 0010 con recaudos y gastos (una anulación se ve como su original).
drop policy capital_operations_ctx on adex.capital_operations;
create policy capital_operations_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or admin_membership_id = adex.ctx_membership()
        or (coalesce(reverses_kind, kind) in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'LOAN_DISBURSEMENT',
                                              'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE')
            and (adex.ctx_membership() in (worker_membership_id, counterpart_membership_id)
                 or (adex.ctx_is(array['admin', 'supervisor', 'socio'])
                     and (adex.ctx_route_allowed(route_id) or adex.ctx_route_allowed(to_route_id)))))
        or (coalesce(reverses_kind, kind) = 'PARTNER_CONTRIBUTION' and counterpart_membership_id = adex.ctx_membership())));

-- ============================================================
-- 4. Capacidades de CLEAN que la base vuelve a comprobar (amplía 0010)
-- ============================================================
-- Fuente: `ROLE_CAPABILITIES` + `INCOMPATIBLE_BY_ROLE` (lo verifica CAN-SQL-001).
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
      else array[]::text[] end), false)
  $$;

-- ============================================================
-- 5. Piezas internas
-- ============================================================
-- Corrección (hallada por CC5-004): dos transacciones que crean a la vez la MISMA cuenta
-- nueva chocaban en el índice único `capital_accounts_key` (0009 solo absorbía el
-- conflicto de la clave primaria) y la segunda fallaba con 23505. Sin árbitro, el
-- conflicto en cualquiera de los dos índices espera a la otra y se absorbe.
create or replace function adex.capital_account_for(p_company text, p_kind text, p_membership text, p_route text) returns text
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_id text := 'acc-' || md5(p_company || '|' || p_kind || '|' || coalesce(p_membership, '') || '|' || coalesce(p_route, ''));
  begin
    insert into adex.capital_accounts (id, company_id, kind, membership_id, route_id)
    values (v_id, p_company, p_kind, p_membership, p_route) on conflict do nothing;
    return v_id;
  end $$;

-- Capital reconocido tras cobrar `p_paid` de un crédito (proporción capital/total).
create function adex.credit_principal_of(p_paid bigint, p_value bigint, p_total bigint) returns bigint
  language sql immutable
  as $$ select case when p_total <= 0 then 0 else round(p_paid::numeric * p_value / p_total)::bigint end $$;

-- Cuotas y crédito desde el total pagado NETO (`recalculateSaleFromPayments` de CLEAN):
-- la cascada por número de cuota no depende del orden de los pagos, solo de su suma.
-- Estado de cada cuota (`updateInstallmentStatuses`) con la fecha de la empresa.
create function adex.credit_recompute(p_company text, p_sale text, p_today date, p_paid_on date) returns bigint
  language plpgsql
  as $$
  declare v_paid bigint; v_balance bigint; s adex.sales;
  begin
    select * into s from adex.sales where company_id = p_company and id = p_sale;
    select coalesce(sum(amount_minor), 0) into v_paid from adex.payments where company_id = p_company and sale_id = p_sale;
    update adex.installments i
       set paid_minor = x.paid, balance_minor = x.amount_minor - x.paid, status = x.status,
           days_overdue = case when x.status = 'pagada' then 0 else greatest(0, p_today - x.due_date) end
      from (select y.id, y.amount_minor, y.due_date, y.paid,
                   case when y.amount_minor - y.paid = 0 and v_paid > y.before then 'pagada'
                        when y.paid = 0 and p_today > y.due_date then 'vencida'
                        when y.paid > 0 and y.amount_minor - y.paid > 0 then 'parcial'
                        when y.amount_minor - y.paid = 0 then 'pagada'
                        else 'pendiente' end as status
              from (select z.id, z.amount_minor, z.due_date, z.before, least(z.amount_minor, greatest(0, v_paid - z.before)) as paid
                      from (select id, amount_minor, due_date,
                                   coalesce(sum(amount_minor) over (order by number rows between unbounded preceding and 1 preceding), 0) as before
                              from adex.installments where company_id = p_company and sale_id = p_sale) z) y) x
     where i.company_id = p_company and i.id = x.id;
    select coalesce(sum(balance_minor), 0) into v_balance from adex.installments where company_id = p_company and sale_id = p_sale;
    -- Una venta perdida o refinanciada nunca cambia de estado al recalcular (CLEAN).
    update adex.sales
       set balance_minor = v_balance,
           status = case when s.status in ('activa', 'finalizada') then case when v_balance <= 0 then 'finalizada' else 'activa' end else s.status end,
           -- Fecha real de finalización: se sella con la fecha contable del pago que salda;
           -- se limpia si una anulación reabre el crédito (`resolveSealedCompletionDate`).
           finished_on = case when s.status in ('activa', 'finalizada') and v_balance <= 0 then coalesce(s.finished_on, p_paid_on)
                              when s.status in ('activa', 'finalizada') then null else s.finished_on end,
           updated_at = now()
     where company_id = p_company and id = p_sale;
    return v_balance;
  end $$;

-- Bloqueo de cuentas en el orden global (empresa → bolsas → custodias → cartera →
-- socios → externa → interés → gasto, id asc).
create function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense'], kind), id
      for update;
  end $$;

-- Patas de una operación (se omiten los importes cero). El balance de la operación lo
-- comprueba al COMMIT `capital_entries_balanced` (0009).
create function adex.capital_write_legs(p_company text, p_op text, p_accounts text[], p_amounts bigint[]) returns void
  language plpgsql
  as $$
  declare v_i int; v_leg int := 0; v_bal bigint;
  begin
    for v_i in 1 .. array_length(p_accounts, 1) loop
      continue when p_amounts[v_i] = 0;
      v_leg := v_leg + 1;
      update adex.capital_accounts set balance_minor = balance_minor + p_amounts[v_i], version = version + 1, updated_at = now()
       where company_id = p_company and id = p_accounts[v_i] returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (p_company, p_op, v_leg, p_accounts[v_i], p_amounts[v_i], v_bal);
    end loop;
  end $$;

-- Contexto mínimo de un comando de dinero (mismas comprobaciones que `capital_post`).
create type adex.money_ctx as (company text, actor text, role text, identity uuid, currency char(3), today date);
create function adex.money_context(p_operation_id uuid) returns adex.money_ctx
  language plpgsql
  as $$
  declare r adex.money_ctx;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'money commands run only through the company API'); end if;
    select adex.ctx_company() as company, adex.ctx_membership() as actor, adex.ctx_role() as role, adex.ctx_identity() as identity,
           c.currency_code as currency, (now() at time zone c.timezone)::date as today
      into r from adex.companies c where c.id = adex.ctx_company();
    if r.role is null or r.company is null or r.identity is null or r.actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if p_operation_id is null then perform adex.capital_raise('AX411', 'operation id is required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = r.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    return r;
  end $$;

-- Responsable de capital VÁLIDO de una ruta (o NULL).
create function adex.route_valid_controller(p_company text, p_route text) returns text
  language sql stable
  as $$
    select case when r.capital_controller_membership_id is not null and adex.route_controller_valid_internal(p_company, p_route)
                then r.capital_controller_membership_id end
      from adex.routes r where r.company_id = p_company and r.id = p_route
  $$;

-- ============================================================
-- 6. Recaudo: `adex.collection_post`
-- ============================================================
-- `p_collector` = responsable del efectivo, resuelto en la API con la regla de CLEAN y
-- revalidado aquí: un Cobrador o Supervisor responde por lo suyo; un actor
-- administrativo indica a un trabajador de la ruta o, si la ruta no tiene Cobrador
-- activo, se indica a sí mismo y el cobro va a la bolsa del responsable (C1).
create function adex.collection_post(p_operation_id uuid, p_sale text, p_amount bigint, p_collector text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    s          adex.sales;
    v_route    text;
    v_ctrl     text;
    v_n        int;
    v_balance  bigint;
    v_applied  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_receiver text;
    v_kind     text;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_payment  text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('payment.register') then perform adex.capital_raise('42501', 'no collection authority'); end if;
    if p_sale is null or p_collector is null or p_amount is null or p_amount <= 0 then
      perform adex.capital_raise('AX411', 'sale, collector and a positive amount are required');
    end if;
    if p_note is not null and length(p_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    if not adex.route_operational(x.company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit does not accept payments (' || s.status || ')'); end if;
    if s.disbursement_status = 'pendiente' then perform adex.capital_raise('AX702', 'the credit is not disbursed'); end if;
    if s.ledger_operation_id is null then perform adex.capital_raise('AX703', 'the credit has no ledger disbursement'); end if;
    select count(*), coalesce(sum(balance_minor), 0) into v_n, v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    if v_n = 0 then perform adex.capital_raise('AX704', 'the credit has no installments'); end if;
    if v_balance <= 0 then perform adex.capital_raise('AX705', 'the credit has no balance'); end if;

    -- Responsable del efectivo (`resolveResponsibleCollector`, revalidado bajo bloqueo).
    v_ctrl := adex.route_valid_controller(x.company, v_route);
    if x.role in ('cobrador', 'supervisor') then
      if p_collector is distinct from x.actor then perform adex.capital_raise('AX708', 'your collections are your responsibility'); end if;
      if not adex.capital_custodian_ok(x.company, v_route, x.actor) then perform adex.capital_raise('AX708', 'you cannot hold cash in this route'); end if;
      v_kind := 'custody';
    elsif p_collector = x.actor then
      -- Actor administrativo sin caja personal: solo en una ruta sin Cobrador activo.
      if exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.company_id = m.company_id and mr.membership_id = m.id
                  where m.company_id = x.company and mr.route_id = v_route and m.role = 'cobrador' and m.status = 'activo') then
        perform adex.capital_raise('AX707', 'indicate who received the cash');
      end if;
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      v_kind := 'admin';
    else
      if not adex.capital_custodian_ok(x.company, v_route, p_collector) then perform adex.capital_raise('AX708', 'the collector cannot hold cash in this route'); end if;
      v_kind := 'custody';
    end if;
    v_receiver := case v_kind when 'custody' then adex.capital_account_for(x.company, 'custody', p_collector, v_route)
                              else adex.capital_account_for(x.company, 'admin', v_ctrl, null) end;

    -- Tope al saldo y reparto capital / interés.
    v_applied := least(p_amount, v_balance);
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p_sale;
    v_principal := adex.credit_principal_of(v_paid + v_applied, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := v_applied - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
    values (v_payment, x.company, p_sale, s.client_id, v_route, p_collector, x.actor, v_applied, x.today, 'efectivo', nullif(btrim(p_note), ''),
            'synced', now(), 'active', v_op, v_principal, v_interest);
    v_new := adex.credit_recompute(x.company, p_sale, x.today, x.today);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_operation_id, 'COLLECTION', v_applied, x.currency, v_route, case when v_kind = 'admin' then v_ctrl end,
            case when v_kind = 'custody' then p_collector end, p_sale, v_payment, 'Recaudo de cuota', x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[v_applied, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'saleId', p_sale, 'routeId', v_route,
      'collectorId', p_collector, 'receiver', v_kind, 'requestedMinor', p_amount, 'appliedMinor', v_applied, 'capped', v_applied < p_amount,
      'previousBalanceMinor', v_balance, 'newBalanceMinor', v_new, 'principalMinor', v_principal, 'interestMinor', v_interest,
      'paymentDate', x.today);
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

-- ============================================================
-- 7. Anulación de un recaudo: `adex.collection_reverse`
-- ============================================================
create function adex.collection_reverse(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    p          adex.payments;
    o          adex.capital_operations;
    s          adex.sales;
    v_route    text;
    v_closed   boolean;
    v_date     date;
    v_receiver text;
    v_rkind    text;
    v_rmember  text;
    v_bal      bigint;
    v_carried  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_rev      text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('payment.reverse') then perform adex.capital_raise('42501', 'no reversal authority'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select route_id into v_route from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'payment not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito → pago → cuentas.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    select * into s from adex.sales where company_id = x.company and id = p.sale_id for update;
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    if p.state = 'reversal' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
    if p.state = 'reversed' then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
    if p.ledger_operation_id is null then perform adex.capital_raise('AX706', 'payment without ledger entry is not corrected here'); end if;
    select * into o from adex.capital_operations where company_id = x.company and id = p.ledger_operation_id;

    -- D7 (6C.1): fecha del original si su semana sigue abierta; si no, hoy (con autoridad
    -- de ajuste); el asiento del libro va hoy y hoy debe estar abierto.
    v_closed := adex.capital_period_closed(x.company, v_route, p.payment_date);
    if v_closed and not adex.ctx_can('payment.approveAdjustment') then perform adex.capital_raise('42501', 'closed period needs adjustment authority'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    v_date := case when v_closed then x.today else p.payment_date end;

    -- Quien recibió el dinero debe conservarlo (nunca se devuelve dinero ya usado).
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = x.company and e.operation_id = o.id and e.amount_minor > 0 and a.kind in ('custody', 'admin');
    if v_rkind = 'custody' and adex.same_person(x.company, x.actor, v_rmember) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;
    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_receiver;
    if v_bal - v_carried < p.amount_minor then perform adex.capital_raise('AX413', 'the cash was already used'); end if;

    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p.sale_id;
    v_principal := adex.credit_principal_of(v_paid - p.amount_minor, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := -p.amount_minor - v_principal;
    if v_principal > 0 or v_interest > 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, reverses_payment_id, correction_reason,
                               corrected_by_membership_id, corrected_at, ledger_operation_id, principal_minor, interest_minor)
    values (v_rev, x.company, p.sale_id, p.client_id, v_route, p.collector_membership_id, x.actor, -p.amount_minor, v_date, p.payment_type,
            'Anulación del pago ' || p.id, 'synced', now(), 'reversal', p.id, btrim(p_reason), x.actor, now(), v_op, v_principal, v_interest);
    update adex.payments set state = 'reversed', reversal_payment_id = v_rev, correction_reason = btrim(p_reason),
                             corrected_by_membership_id = x.actor, corrected_at = now()
     where company_id = x.company and id = p.id;
    v_new := adex.credit_recompute(x.company, p.sale_id, x.today, v_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', p.amount_minor, x.currency, v_route, o.admin_membership_id, o.worker_membership_id,
            p.sale_id, v_rev, o.id, 'COLLECTION', btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[-p.amount_minor, -v_principal, -v_interest]);

    return jsonb_build_object('reversalPaymentId', v_rev, 'operationId', v_op, 'paymentId', p.id, 'saleId', p.sale_id, 'routeId', v_route,
      'amountMinor', p.amount_minor, 'reversalDate', v_date, 'periodClosed', v_closed, 'newBalanceMinor', v_new);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'payments_company_id_reverses_payment_id_key') then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
      raise;
  end $$;

-- ============================================================
-- 8. Gasto: `adex.expense_post`
-- ============================================================
create function adex.expense_post(
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
        v_payer := adex.capital_account_for(x.company, 'admin', v_ctrl, null);
      else
        if not adex.capital_custodian_ok(x.company, p_route, p_worker) then perform adex.capital_raise('AX403', 'the worker cannot answer for an expense in this route'); end if;
        -- Cargarlo a OTRA persona es operar con su efectivo (`settle`).
        if p_worker is distinct from x.actor then
          if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'expenses you register are yours'); end if;
          if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
          if not (x.actor is not distinct from v_ctrl or x.role = 'superadmin'
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

-- ============================================================
-- 9. Corrección de gastos: anulación y reintegro
-- ============================================================
-- Original corregible, bloqueado, con su autoridad: D12 para gastos de bolsa; F5-D02
-- para gastos de ruta y de trabajador. Devuelve la cuenta que pagó (la anulación
-- devuelve el importe a ESA cuenta, aunque luego cambie el responsable) y la de gasto.
create type adex.expense_fix as (id text, amount bigint, route text, scope text, op text, kind text, admin text, worker text, payer text, expacc text, refunded bigint);
create function adex.expense_correctable(x adex.money_ctx, p_expense text, p_refund boolean) returns adex.expense_fix
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
    if e.scope is distinct from 'empresa' then
      -- F5-D02 (aprobada 2026-10-17): anulación de gastos de trabajador y de ruta.
      if p_refund then perform adex.capital_raise('AX713', 'only pool expenses have refunds'); end if;
      -- Autoridad `correct`: el Administrador responsable de capital de la ruta o el SuperAdmin.
      v_ctrl := adex.route_valid_controller(x.company, e.route_id);
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
        perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can reverse');
      end if;
      -- Control independiente: quien anula no es la PERSONA que registró (ni con otra membresía).
      if adex.same_person(x.company, x.actor, e.registered_by_membership_id) then
        perform adex.capital_raise('AX717', 'the person who registered the expense cannot reverse it');
      end if;
      -- D7: la anulación se asienta hoy, que debe estar abierto; si la semana del gasto está
      -- cerrada, es un ajuste en el periodo abierto y exige la autoridad de aprobar ajustes.
      if adex.capital_period_closed(x.company, e.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      if adex.capital_period_closed(x.company, e.route_id, e.expense_date) and not adex.ctx_can('payment.approveAdjustment') then
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
    return r;
  end $$;

create function adex.expense_reverse(p_operation_id uuid, p_expense text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare x adex.money_ctx; c adex.expense_fix; v_rev text := gen_random_uuid()::text; v_op text := gen_random_uuid()::text; v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 200 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    c := adex.expense_correctable(x, p_expense, false);
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

-- Reintegro parcial (D12): solo gastos de bolsa, hasta lo no reintegrado.
create function adex.expense_refund(p_operation_id uuid, p_expense text, p_amount bigint, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare x adex.money_ctx; c adex.expense_fix; v_row text := gen_random_uuid()::text; v_op text := gen_random_uuid()::text; v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 200 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    c := adex.expense_correctable(x, p_expense, true);
    if p_amount > c.amount - c.refunded then perform adex.capital_raise('AX714', 'the refund exceeds what remains of the expense'); end if;
    perform adex.capital_lock_accounts(x.company, array[c.payer, c.expacc]);
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, sync_status, created_at, refunds_expense_id,
                               reversal_reason, ledger_operation_id)
    select v_row, company_id, route_id, scope, category_id, -p_amount, 'Reintegro: ' || btrim(p_reason), x.today, x.actor,
           collector_membership_id, funding, funding_admin_membership_id, 'synced', now(), id, btrim(p_reason), v_op
      from adex.expenses where company_id = x.company and id = c.id;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'EXPENSE_REFUND', p_amount, x.currency, c.route, c.admin, c.worker, v_row, btrim(p_reason),
            x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[c.payer, c.expacc], array[p_amount, -p_amount]);
    return jsonb_build_object('refundExpenseId', v_row, 'operationId', v_op, 'expenseId', c.id, 'amountMinor', p_amount,
                              'remainingMinor', c.amount - c.refunded - p_amount);
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

-- ============================================================
-- 10. Privilegios
-- ============================================================
-- Lectura con RLS (ya concedida); NINGUNA escritura directa: solo las funciones.
grant execute on function adex.collection_post(uuid, text, bigint, text, text), adex.collection_reverse(uuid, text, text),
  adex.expense_post(uuid, text, text, text, text, bigint, text, text, text, text), adex.expense_reverse(uuid, text, text),
  adex.expense_refund(uuid, text, bigint, text), adex.credit_principal_of(bigint, bigint, bigint) to adex_api;
revoke all on function adex.credit_recompute(text, text, date, date), adex.capital_lock_accounts(text, text[]),
  adex.capital_write_legs(text, text, text[], bigint[]), adex.money_context(uuid), adex.route_valid_controller(text, text),
  adex.expense_correctable(adex.money_ctx, text, boolean), adex.guard_custody_negative(), adex.ledger_row_server_guard(),
  adex.guard_payment_ledger_facts() from public;
