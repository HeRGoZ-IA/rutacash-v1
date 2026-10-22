-- ============================================================
-- 0028 · SuperAdmin: CARTERA de solo lectura (Ronda 67)
-- ============================================================
-- Decisión del propietario: en CARTERA el SuperAdmin conserva SOLO Clientes y en modo consulta.
-- Segunda barrera (la primera es la matriz `src/lib/permissions.ts`, que la API aplica):
--   · `clients_manage_insert/update/delete`: sin 'superadmin' (no crea, edita, cambia de ruta
--     ni borra clientes). La lectura (`clients_ctx`) no cambia; la de solicitudes se le reconoce
--     expresamente (antes venía de `authorization.access`).
--   · `adex.ctx_can`: la de 0023 sin 'superadmin' en ventas, autorizaciones y pagos. Las
--     funciones de crédito, cobro, visita, corrección y ajuste ya consultan `ctx_can`, así que
--     rechazan al SuperAdmin aunque alguien llame a la base sin pasar por la API.
--   · `adex.expense_correctable`: la de 0013 con UNA diferencia. Anular un gasto de una semana
--     cerrada pedía `payment.approveAdjustment`; el SuperAdmin ya no la tiene, pero anular gastos
--     es una facultad suya de DINERO que se conserva (`expense.correct`), así que la regla lo
--     admite expresamente. Para el resto de roles la regla es idéntica.
-- Nada cambia para Administrador, Supervisor, Cobrador ni Secretario. Sin cambios de datos.

alter policy clients_manage_insert on adex.clients
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
              and adex.ctx_is(array['admin', 'supervisor', 'cobrador'])
              and adex.route_operational(company_id, route_id)
              and document_type is not null and status = 'activo' and not document_legacy_duplicate);
alter policy clients_manage_update on adex.clients
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['admin', 'secretario']))
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id));
alter policy clients_manage_delete on adex.clients
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_is(array['admin']));

-- Solicitudes: la lectura dependía de `authorization.access`, que el SuperAdmin ya no tiene. CONSULTAR
-- sigue siendo suyo (ve toda su empresa): se le reconoce la lectura expresamente; escribir, no.
alter policy sale_requests_ctx on adex.sale_requests
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))
          AND ((select adex.ctx_can('authorization.access'::text)) OR ((requested_by_membership_id)::text = adex.ctx_membership())
               OR (select adex.ctx_is(array['superadmin'])))));

-- Capacidades de la base: las de 0023 sin el SuperAdmin en la escritura de cartera.
create or replace function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['admin']
      when 'authorization.access'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['supervisor', 'secretario']
      when 'payment.register'                 then array['admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['admin']
      when 'payment.approveAdjustment'        then array['admin']
      when 'payment.correct'                  then array['admin', 'secretario']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      else array[]::text[] end), false)
  $$;

-- Anulación de gastos: la de 0013; el SuperAdmin conserva la de semanas cerradas.
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
      if adex.capital_period_closed(x.company, e.route_id, e.expense_date)
         and not (adex.ctx_can('payment.approveAdjustment') or x.role = 'superadmin') then
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
