-- ============================================================
-- 0032 · Rectificación de ventas con pagos registrados (intervención post-R73, bloque A)
-- ============================================================
-- R73 (0030) solo corregía una venta SIN ningún pago, ni siquiera anulado. Esta migración:
--
-- A1 · Pagos íntegramente anulados: el guardián ya no mira si «existe algún pago», sino el
--      EFECTO NETO: pagado neto (originales + anulaciones), capital reconocido e interés
--      reconocido. Si las anulaciones dejaron todo en cero, la venta se corrige como antes.
--      Nada se borra: originales, anulaciones, rectificación y auditoría quedan.
--
-- A2 · Pagos vigentes: la venta se corrige conservando cada pago (importe, fecha, quién y
--      evidencia). Se recalculan las cuotas con el pagado neto y la imputación capital/
--      interés acumulada (F5-D01) con las condiciones nuevas. La diferencia de imputación
--      es una RECLASIFICACIÓN (operación nueva `PRINCIPAL_RECLASSIFICATION`, de hoy) entre
--      la cartera y el interés de la ruta: no toca ninguna cuenta de efectivo, no es un
--      recaudo nuevo y no cambia ningún cuadre ni cierre (sus cifras archivadas son de
--      custodia y huella de operaciones de su rango). El siguiente recaudo imputa sobre la
--      imputación ajustada (`sales.principal_reclassified_minor`), sin doble reconocimiento.
--
-- C  · Reaplicar un pago anulado (`adex.collection_reapply`): el MISMO efectivo vuelve a la
--      MISMA cuenta que lo recibió, con su fecha original si su semana sigue abierta, en una
--      operación nueva enlazada al pago anulado. Bloqueada si la anulación ya entró en un
--      cuadre de esa custodia (podría existir un sobrante con ese dinero), si el pago fue
--      corregido (su reemplazo ya existe), si ya se reaplicó, si el custodio cambió o si
--      excede el saldo. No hay reaplicación desde «Sobrante en control».
--
-- Se mantiene de R73 (D73-03): periodo cerrado, cobros sin conexión sin confirmar y, cuando
-- CAMBIA EL CAPITAL entregado, desembolso en cuadre, custodio cambiado, saldo insuficiente y
-- bolsa de otro Administrador. Nuevo bloqueo: el total corregido no puede quedar por debajo
-- de lo ya pagado (sin política de sobrepagos y devoluciones).
--
-- Solo añade: columnas con valor por defecto, un tipo de operación, funciones y políticas.
-- No modifica ni borra filas existentes.

-- ---------- Libro: tipo de operación de reclasificación capital/interés ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION'));
-- Pertenece a un crédito. Nunca se anula (no está entre los `reverses_kind` admitidos):
-- una reclasificación equivocada se corrige con otra rectificación.
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION')) = (sale_id is not null));

-- Visibilidad: la de 0030 más la reclasificación (la ven quienes ven el ajuste del desembolso).
alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text, 'DISBURSEMENT_ADJUSTMENT'::text, 'PRINCIPAL_RECLASSIFICATION'::text])) AND ((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text) OR (( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((to_route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)))))))));

-- ---------- Crédito: capital reclasificado (imputación ajustada) ----------
alter table adex.sales add column principal_reclassified_minor bigint not null default 0;
comment on column adex.sales.principal_reclassified_minor is
  'Bloque A post-R73: Σ reclasificaciones capital/interés de las rectificaciones. Capital reconocido = Σ pagos.principal_minor + este valor.';

-- ---------- Pagos: reaplicación de un pago anulado ----------
alter table adex.payments add column reapplies_payment_id adex.eid;
alter table adex.payments add constraint payments_reapplies_fk
  foreign key (company_id, reapplies_payment_id) references adex.payments(company_id, id) deferrable initially deferred;
-- Un pago anulado se reaplica una sola vez; solo un pago vigente reaplica.
create unique index payments_one_reapplication on adex.payments (company_id, reapplies_payment_id) where reapplies_payment_id is not null;
alter table adex.payments add constraint payments_reapply_shape
  check (reapplies_payment_id is null or (coalesce(state, 'active') in ('active', 'reversed') and amount_minor > 0));

-- ---------- Historial de rectificaciones: pagos y reclasificación ----------
alter table adex.credit_rectifications add column net_paid_minor bigint not null default 0;
alter table adex.credit_rectifications add column principal_reclass_minor bigint not null default 0;
alter table adex.credit_rectifications add column reclass_operation_id adex.eid;
alter table adex.credit_rectifications add constraint credit_rectifications_reclass_shape
  check ((principal_reclass_minor = 0) = (reclass_operation_id is null));
alter table adex.credit_rectifications add constraint credit_rectifications_reclass_fk
  foreign key (company_id, reclass_operation_id) references adex.capital_operations(company_id, id);

-- ---------- Casos registrables: motivos nuevos ----------
alter table adex.credit_rectification_cases drop constraint credit_rectification_cases_blocker_check;
alter table adex.credit_rectification_cases add constraint credit_rectification_cases_blocker_check
  check (blocker in ('INSUFFICIENT_FUNDS', 'CUSTODIAN_CHANGED', 'DISBURSEMENT_SETTLED', 'PERIOD_CLOSED', 'OFFLINE_PENDING',
                     'CREDIT_HAS_COLLECTIONS', 'POOL_OF_ANOTHER_ADMIN', 'OVERPAYMENT', 'PAYMENT_ADJUSTMENT_PENDING',
                     'LEGACY_PAYMENTS', 'LEDGER_INCONSISTENT'));

-- Id determinista de un paso derivado de una operación (reintentos: mismos asientos o ninguno).
create function adex.derived_operation_id(p_operation_id uuid, p_tag text) returns uuid
  language sql immutable
  as $$ select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
          from (select md5(p_operation_id::text || ':' || p_tag) h) q $$;

-- ---------- Recaudos: el capital reconocido incluye la reclasificación ----------
-- `collection_reverse` y `collection_post` de 0017 con UNA diferencia cada una: el capital ya
-- reconocido (`v_known`) suma `sales.principal_reclassified_minor`. Sin rectificaciones con
-- pagos, ese valor es 0 y el resultado es idéntico.

create or replace function adex.collection_reverse(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
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
    if not (adex.ctx_can('payment.reverse') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no reversal authority'); end if;
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
    v_known := v_known + s.principal_reclassified_minor;
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

create or replace function adex.collection_post(p_operation_id uuid, p_sale text, p_amount bigint, p_collector text, p_note text) returns jsonb
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
    if not (adex.ctx_can('payment.register') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no collection authority'); end if;
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
    elsif adex.correction_step(p_operation_id)
          and (select m.role from adex.memberships m where m.company_id = x.company and m.id = p_collector) not in ('cobrador', 'supervisor') then
      -- Corrección (0017) de un cobro que entró a la BOLSA: el reemplazo vuelve a la bolsa del responsable.
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
    v_known := v_known + s.principal_reclassified_minor;
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

-- `route_period_figures` de 0030 con UNA diferencia: el capital cobrado incluye la reclasificación
-- (así capital cobrado + interés cobrado = recaudos del periodo) y se informa aparte. Las cifras
-- de custodia y la huella de operaciones (lo que compara la conciliación de cierres) no cambian.
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
             coalesce(sum(amt) filter (where d >= p_from and b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                     'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'WORKER_EXPENSE')), 0)::bigint other,
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

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops);
  end $$;

-- ============================================================
-- A1/A2 · rectificación con pagos (misma firma que 0030)
-- ============================================================
create or replace function adex.credit_rectify(
  p_operation_id   uuid,
  p_sale           text,
  p_expected_count integer,
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,
  p_reason         text,
  p_evidence       text,
  p_offline_checked boolean
) returns table (rectification_id text, adjustment_id text, delta_minor bigint)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_today    date;
    v_currency char(3);
    v_route    text;
    s          adex.sales;
    v_orig     adex.capital_operations;
    v_payer    text;
    v_pkind    text;
    v_powner   text;
    v_pseq     bigint;
    v_portf    text;
    v_income   text;
    v_bal      bigint;
    v_carried  bigint;
    v_total    bigint;
    v_value    bigint;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    v_delta    bigint;
    v_adj      text;
    v_rect     text := gen_random_uuid()::text;
    v_before   jsonb;
    v_after    jsonb;
    i          record;
    v_cname    text;
    -- Pagos (A1/A2)
    v_pays     int;
    v_paid     bigint;
    v_known    bigint;
    v_inst_paid bigint;
    v_paid_on  date;
    v_reclass  bigint := 0;
    v_rop      text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are rectified only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    if p_operation_id is null or p_sale is null then perform adex.capital_raise('AX411', 'operation id and credit are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id in (p_operation_id, adex.derived_operation_id(p_operation_id, 'reclassification')))
       or exists (select 1 from adex.credit_rectifications where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300
       or p_evidence is null or length(btrim(p_evidence)) < 10 or length(p_evidence) > 500 then
      perform adex.capital_raise('AX411', 'reason and evidence are required');
    end if;
    if p_offline_checked is distinct from true then
      perform adex.capital_raise('AX411', 'confirm there are no offline captures pending for this credit');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;

    -- Bloqueos: ruta → crédito → cuentas (el crédito bloqueado detiene recaudos y anulaciones).
    select route_id into v_route from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    perform 1 from adex.routes where company_id = v_company and id = v_route for update;
    select * into s from adex.sales where company_id = v_company and id = p_sale for update;
    if s.route_id <> v_route then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if s.rectification_count is distinct from p_expected_count then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit is not active (' || s.status || ')'); end if;
    if s.disbursement_status is distinct from 'desembolsado' or s.ledger_operation_id is null then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;

    -- Pagos: lo que cuenta es el efecto NETO (originales + anulaciones) y su imputación.
    select count(*), coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0),
           max(payment_date) filter (where amount_minor > 0 and coalesce(state, 'active') = 'active')
      into v_pays, v_paid, v_known, v_paid_on
      from adex.payments where company_id = v_company and sale_id = s.id;
    v_known := v_known + s.principal_reclassified_minor;
    if exists (select 1 from adex.payments where company_id = v_company and sale_id = s.id and ledger_operation_id is null) then
      perform adex.capital_raise('AX526', 'the credit has payments without a ledger entry');
    end if;
    if exists (select 1 from adex.payment_adjustment_requests where company_id = v_company and sale_id = s.id and status = 'pending') then
      perform adex.capital_raise('AX527', 'resolve the pending payment adjustment first');
    end if;
    select coalesce(sum(paid_minor), 0) into v_inst_paid from adex.installments where company_id = v_company and sale_id = s.id;
    if s.balance_minor <> s.total_value_minor - v_paid or v_inst_paid <> v_paid
       or v_known <> adex.credit_principal_of(v_paid, s.sale_value_minor, s.total_value_minor) then
      perform adex.capital_raise('AX420', 'collections and their allocation do not reconcile');
    end if;

    -- Desembolso original y la cuenta que pagó (pata negativa).
    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if not found or v_orig.kind <> 'LOAN_DISBURSEMENT' or v_orig.sale_id is distinct from s.id then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;
    select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
    if v_payer is null or v_pkind not in ('custody', 'admin') then perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger'); end if;

    v_delta := p_amount - s.sale_value_minor;
    -- Cambio de capital entregado: los controles de SOC-09 (la diferencia mueve efectivo de la
    -- cuenta que pagó). Sin cambio de capital ninguna cuenta de efectivo se toca.
    if v_delta is distinct from 0 then
      if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs
           where cs.company_id = v_company and cs.custody_account_id = v_payer and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
        perform adex.capital_raise('AX521', 'the disbursement is already included in a settlement');
      end if;
      if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, v_route, v_powner) then
        perform adex.capital_raise('AX522', 'the worker who paid no longer holds cash in this route');
      end if;
      if v_pkind = 'admin' and v_powner is distinct from v_actor then
        perform adex.capital_raise('AX402', 'only the administrator whose pool paid rectifies this credit');
      end if;
    end if;
    -- D73-03: ningún periodo cerrado (desembolso, calendario anterior o nuevo, hoy).
    if adex.capital_period_closed(v_company, v_route, v_orig.entry_date) or adex.capital_period_closed(v_company, v_route, s.disbursement_date)
       or adex.capital_period_closed(v_company, v_route, s.start_date) or adex.capital_period_closed(v_company, v_route, p_start)
       or adex.capital_period_closed(v_company, v_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;

    -- Condiciones nuevas (mismas reglas que el desembolso; el inicio no antecede al desembolso).
    if p_amount is null or p_amount <= 0 or p_count is null or p_count not between 1 and 1000 or p_frequency is null
       or p_frequency not in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada') or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 or p_start < coalesce(s.disbursement_date, v_orig.entry_date) then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
    if (p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
       is not distinct from (s.sale_value_minor, s.interest_rate, s.installments_count, s.payment_frequency, s.start_date, s.payment_days) then
      perform adex.capital_raise('AX524', 'nothing to rectify');
    end if;
    v_total := adex.credit_total(p_amount, p_rate);
    v_value := adex.credit_installment(v_total, p_count);
    -- Sin política aprobada de sobrepagos y devoluciones: el total no baja de lo ya pagado.
    if v_total < v_paid then perform adex.capital_raise('AX525', 'the corrected total is below what was already paid'); end if;
    select count(*), coalesce(sum((e->>'amountMinor')::numeric), 0), max((e->>'dueDate')::date) into v_n, v_sum, v_end
      from jsonb_array_elements(coalesce(p_schedule, '[]'::jsonb)) e;
    if v_n <> p_count or v_sum <> v_total
       or exists (select 1 from jsonb_array_elements(p_schedule) with ordinality x(e, k)
                   where (e->>'number')::int <> k or (e->>'dueDate')::date < p_start
                      or (k < p_count and (e->>'amountMinor')::bigint <> v_value)
                      or (e->>'amountMinor')::bigint < 0
                      or (k > 1 and (e->>'dueDate')::date < (p_schedule -> (k::int - 2) ->> 'dueDate')::date)) then
      perform adex.capital_raise('AX503', 'installment schedule does not match the conditions');
    end if;

    v_before := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id),
      'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known);

    v_portf := adex.capital_account_for(v_company, 'portfolio', null, v_route);
    -- Diferencia de capital: operación nueva entre la cuenta que pagó y la cartera (SOC-09).
    if v_delta <> 0 then
      perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
        order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified'], kind), id for update;
      if v_delta > 0 then
        select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
        if v_bal - v_carried < v_delta then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      end if;
      v_adj := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_adj, v_company, p_operation_id, 'DISBURSEMENT_ADJUSTMENT', abs(v_delta), v_currency, v_route, v_orig.admin_membership_id,
              v_orig.worker_membership_id, v_orig.sale_request_id, s.id, left('Rectificación de desembolso: ' || btrim(p_reason), 300),
              v_today, v_actor, v_identity, v_role, txid_current());
      update adex.capital_accounts set balance_minor = balance_minor - v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_payer returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 1, v_payer, -v_delta, v_bal);
      update adex.capital_accounts set balance_minor = balance_minor + v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_portf returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 2, v_portf, v_delta, v_bal);
    end if;

    -- Cuotas: la misma fila de cada número se actualiza y las nuevas se añaden; las que quedan
    -- fuera del calendario se SUSTITUYEN (D73-02). Nunca se borra una cuota (0002).
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      update adex.installments set due_date = i.d, amount_minor = i.a, paid_minor = 0, balance_minor = i.a, status = 'pendiente', days_overdue = 0
       where company_id = v_company and sale_id = s.id and number = i.n;
      if not found then
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, v_company, s.id, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
      end if;
    end loop;
    update adex.installments set amount_minor = 0, paid_minor = 0, balance_minor = 0, status = 'sustituida', days_overdue = 0
     where company_id = v_company and sale_id = s.id and number > p_count and status <> 'sustituida';

    update adex.sales set sale_value_minor = p_amount, interest_rate = p_rate, interest_value_minor = v_total - p_amount, total_value_minor = v_total,
                          balance_minor = v_total, installments_count = p_count, installment_value_minor = v_value, payment_frequency = p_frequency,
                          payment_days = p_payment_days, start_date = p_start, estimated_end_date = v_end,
                          rectification_count = rectification_count + 1, updated_at = now()
     where company_id = v_company and id = s.id;
    -- Con historia de pagos, las cuotas y el saldo salen del pagado NETO (motor de recaudos).
    if v_pays > 0 then
      perform adex.credit_recompute(v_company, s.id, v_today, coalesce(v_paid_on, v_today));
    end if;

    -- A2 · reclasificación: capital reconocido con las condiciones nuevas − el ya reconocido.
    v_reclass := adex.credit_principal_of(v_paid, p_amount, v_total) - v_known;
    if v_reclass <> 0 then
      v_income := adex.capital_account_for(v_company, 'income', null, v_route);
      perform adex.capital_lock_accounts(v_company, array[v_portf, v_income]);
      v_rop := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_rop, v_company, adex.derived_operation_id(p_operation_id, 'reclassification'), 'PRINCIPAL_RECLASSIFICATION', abs(v_reclass), v_currency,
              v_route, v_orig.admin_membership_id, v_orig.worker_membership_id, v_orig.sale_request_id, s.id,
              left('Reclasificación capital/interés por rectificación: ' || btrim(p_reason), 300), v_today, v_actor, v_identity, v_role, txid_current());
      perform adex.capital_write_legs(v_company, v_rop, array[v_portf, v_income], array[-v_reclass, v_reclass]);
      update adex.sales set principal_reclassified_minor = principal_reclassified_minor + v_reclass, updated_at = now()
       where company_id = v_company and id = s.id;
    end if;

    select * into s from adex.sales where company_id = v_company and id = p_sale;
    v_after := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id),
      'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known + v_reclass);

    insert into adex.credit_rectifications (id, company_id, sale_id, route_id, operation_id, sequence_no, adjustment_operation_id, delta_minor,
                                            payer_account_id, before_state, after_state, reason, evidence, offline_checked,
                                            actor_membership_id, actor_identity_id, actor_role, business_date, txid,
                                            net_paid_minor, principal_reclass_minor, reclass_operation_id)
    values (v_rect, v_company, s.id, v_route, p_operation_id, s.rectification_count, v_adj, v_delta, v_payer, v_before, v_after,
            btrim(p_reason), btrim(p_evidence), true, v_actor, v_identity, v_role, v_today, txid_current(),
            v_paid, v_reclass, v_rop);
    return query select v_rect, v_adj, v_delta;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'credit_rectifications_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      if v_cname = 'credit_rectifications_company_id_sale_id_sequence_no_key' then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
      raise;
  end $$;

-- ---------- Comprobación previa (sin efectos) ----------
-- Devuelve los bloqueos de HOY separando los generales (`blockers`) de los que solo aplican
-- si cambia el capital entregado (`capitalBlockers`), y el resumen de pagos: lo que se ve en
-- el diálogo antes de intentar. «0 pagos vigentes» no se usa como garantía de nada.
create or replace function adex.credit_rectify_check(p_sale text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_today   date;
    s         adex.sales;
    v_orig    adex.capital_operations;
    v_payer   text; v_pkind text; v_powner text; v_pseq bigint;
    v_bal     bigint; v_carried bigint;
    v_blockers text[] := array[]::text[];
    v_capital  text[] := array[]::text[];
    v_active int; v_reversed int; v_reversals int; v_reapplied int;
    v_paid bigint; v_known bigint; v_inst_paid bigint; v_last date;
  begin
    if adex.ctx_role() is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    select * into s from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    v_today := adex.business_today(v_company);
    if s.status <> 'activa' then v_blockers := array_append(v_blockers, 'CREDIT_NOT_ACTIVE'); end if;

    select count(*) filter (where coalesce(state, 'active') = 'active' and amount_minor > 0),
           count(*) filter (where state = 'reversed'),
           count(*) filter (where state = 'reversal'),
           count(*) filter (where reapplies_payment_id is not null),
           coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0),
           max(payment_date) filter (where coalesce(state, 'active') = 'active' and amount_minor > 0)
      into v_active, v_reversed, v_reversals, v_reapplied, v_paid, v_known, v_last
      from adex.payments where company_id = v_company and sale_id = s.id;
    v_known := v_known + s.principal_reclassified_minor;
    select coalesce(sum(paid_minor), 0) into v_inst_paid from adex.installments where company_id = v_company and sale_id = s.id;
    if exists (select 1 from adex.payments where company_id = v_company and sale_id = s.id and ledger_operation_id is null) then
      v_blockers := array_append(v_blockers, 'LEGACY_PAYMENTS');
    end if;
    if exists (select 1 from adex.payment_adjustment_requests where company_id = v_company and sale_id = s.id and status = 'pending') then
      v_blockers := array_append(v_blockers, 'PAYMENT_ADJUSTMENT_PENDING');
    end if;
    if s.balance_minor <> s.total_value_minor - v_paid or v_inst_paid <> v_paid
       or v_known <> adex.credit_principal_of(v_paid, s.sale_value_minor, s.total_value_minor) then
      v_blockers := array_append(v_blockers, 'LEDGER_INCONSISTENT');
    end if;

    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if found then
      select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
        from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
       where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
      if adex.capital_period_closed(v_company, s.route_id, v_orig.entry_date) or adex.capital_period_closed(v_company, s.route_id, s.disbursement_date)
         or adex.capital_period_closed(v_company, s.route_id, s.start_date) or adex.capital_period_closed(v_company, s.route_id, v_today) then
        v_blockers := array_append(v_blockers, 'PERIOD_CLOSED');
      end if;
      if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs where cs.company_id = v_company and cs.custody_account_id = v_payer
                                           and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
        v_capital := array_append(v_capital, 'DISBURSEMENT_SETTLED');
      end if;
      if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, s.route_id, v_powner) then v_capital := array_append(v_capital, 'CUSTODIAN_CHANGED'); end if;
      if v_pkind = 'admin' and v_powner is distinct from v_actor then v_capital := array_append(v_capital, 'POOL_OF_ANOTHER_ADMIN'); end if;
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    else
      v_blockers := array_append(v_blockers, 'CREDIT_NOT_LEDGERED');
    end if;
    return jsonb_build_object('blockers', to_jsonb(v_blockers), 'capitalBlockers', to_jsonb(v_capital), 'payerKind', v_pkind,
      'maxIncreaseMinor', case when cardinality(v_capital) > 0 then 0 else greatest(coalesce(v_bal, 0) - coalesce(v_carried, 0), 0) end,
      'rectificationCount', s.rectification_count,
      'payments', jsonb_build_object('active', v_active, 'reversed', v_reversed, 'reversals', v_reversals, 'reapplied', v_reapplied,
                                     'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known, 'interestRecognizedMinor', v_paid - v_known,
                                     'lastPaymentDate', v_last),
      -- El total corregido no puede quedar por debajo de lo ya pagado.
      'minTotalMinor', v_paid);
  end $$;

-- ============================================================
-- C · reaplicar un pago anulado
-- ============================================================
create function adex.collection_reapply(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    p          adex.payments;
    rv         adex.payments;
    s          adex.sales;
    v_route    text;
    v_receiver text;
    v_rkind    text;
    v_rmember  text;
    v_rseq     bigint;
    v_date     date;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_payment  text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    -- Solo el Administrador (el SuperAdmin supervisa y no mueve dinero).
    if x.role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator reapplies a reversed payment'); end if;
    if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select route_id into v_route from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'payment not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito → pago → cuentas (los de `collection_reverse`).
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    select * into s from adex.sales where company_id = x.company and id = p.sale_id for update;
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    if p.state is distinct from 'reversed' or p.reversal_payment_id is null or p.amount_minor <= 0 then
      perform adex.capital_raise('AX528', 'only a reversed payment can be reapplied');
    end if;
    if p.corrected_by_payment_id is not null then perform adex.capital_raise('AX528', 'the payment was corrected: its replacement already exists'); end if;
    if exists (select 1 from adex.payments where company_id = x.company and reapplies_payment_id = p.id) then
      perform adex.capital_raise('AX528', 'the payment was already reapplied');
    end if;
    if p.ledger_operation_id is null then perform adex.capital_raise('AX706', 'payment without ledger entry is not corrected here'); end if;
    if not adex.route_operational(x.company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit does not accept payments (' || s.status || ')'); end if;
    if s.ledger_operation_id is null then perform adex.capital_raise('AX703', 'the credit has no ledger disbursement'); end if;
    if s.balance_minor < p.amount_minor then perform adex.capital_raise('AX525', 'reapplying would exceed the balance of the credit'); end if;

    -- La cuenta que recibió el pago original vuelve a recibirlo.
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = x.company and e.operation_id = p.ledger_operation_id and e.amount_minor > 0 and a.kind in ('custody', 'admin');
    if v_receiver is null then perform adex.capital_raise('AX706', 'the original receiver is unknown'); end if;
    select * into rv from adex.payments where company_id = x.company and id = p.reversal_payment_id;
    select e.seq into v_rseq from adex.capital_entries e
     where e.company_id = x.company and e.operation_id = rv.ledger_operation_id and e.account_id = v_receiver;
    if v_rkind = 'custody' then
      if not adex.capital_custodian_ok(x.company, v_route, v_rmember) then
        perform adex.capital_raise('AX522', 'the worker who received the payment no longer holds cash in this route');
      end if;
      -- Si la anulación ya entró en un cuadre, ese efectivo pudo quedar como sobrante: sin
      -- política de conciliación aprobada, no se reaplica.
      if exists (select 1 from adex.custody_settlements cs where cs.company_id = x.company and cs.custody_account_id = v_receiver
                   and cs.status = 'cerrada' and cs.to_seq >= v_rseq) then
        perform adex.capital_raise('AX529', 'the reversal is already included in a settlement');
      end if;
    elsif v_rmember is distinct from x.actor then
      perform adex.capital_raise('AX402', 'only the administrator whose pool received the payment reapplies it');
    end if;
    -- Fecha del pago original si su semana sigue abierta; si no, hoy. El asiento va hoy (D7).
    v_date := case when adex.capital_period_closed(x.company, v_route, p.payment_date) then x.today else p.payment_date end;

    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p.sale_id;
    v_known := v_known + s.principal_reclassified_minor;
    v_principal := adex.credit_principal_of(v_paid + p.amount_minor, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := p.amount_minor - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor,
                               reapplies_payment_id)
    values (v_payment, x.company, p.sale_id, p.client_id, v_route, p.collector_membership_id, x.actor, p.amount_minor, v_date, p.payment_type,
            left('Reaplicación del pago ' || p.id || ': ' || btrim(p_reason), 500), 'synced', now(), 'active', v_op, v_principal, v_interest, p.id);
    v_new := adex.credit_recompute(x.company, p.sale_id, x.today, v_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_operation_id, 'COLLECTION', p.amount_minor, x.currency, v_route, case when v_rkind = 'admin' then v_rmember end,
            case when v_rkind = 'custody' then v_rmember end, p.sale_id, v_payment, left('Reaplicación de pago anulado: ' || btrim(p_reason), 300),
            x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[p.amount_minor, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'reappliesPaymentId', p.id, 'saleId', p.sale_id, 'routeId', v_route,
      'collectorId', p.collector_membership_id, 'receiver', v_rkind, 'amountMinor', p.amount_minor, 'paymentDate', v_date,
      'principalMinor', v_principal, 'interestMinor', v_interest, 'newBalanceMinor', v_new);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'payments_one_reapplication' then perform adex.capital_raise('AX528', 'the payment was already reapplied'); end if;
      raise;
  end $$;
revoke all on function adex.collection_reapply(uuid, text, text) from public;
grant execute on function adex.collection_reapply(uuid, text, text) to adex_api;

-- ¿Se puede reaplicar? Misma lógica sin escribir (para el diálogo). Solo el Administrador.
create function adex.collection_reapply_check(p_payment text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_today date;
    p adex.payments; rv adex.payments; s adex.sales;
    v_receiver text; v_rkind text; v_rmember text; v_rseq bigint;
    v_blockers text[] := array[]::text[];
  begin
    if adex.ctx_role() is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator reapplies a reversed payment'); end if;
    select * into p from adex.payments where company_id = v_company and id = p_payment;
    if not found or not adex.ctx_route_allowed(p.route_id) then perform adex.capital_raise('AX412', 'payment not found'); end if;
    v_today := adex.business_today(v_company);
    select * into s from adex.sales where company_id = v_company and id = p.sale_id;
    if p.state is distinct from 'reversed' or p.reversal_payment_id is null then v_blockers := array_append(v_blockers, 'NOT_REVERSED'); end if;
    if p.corrected_by_payment_id is not null then v_blockers := array_append(v_blockers, 'CORRECTED'); end if;
    if exists (select 1 from adex.payments where company_id = v_company and reapplies_payment_id = p.id) then v_blockers := array_append(v_blockers, 'ALREADY_REAPPLIED'); end if;
    if adex.capital_period_closed(v_company, p.route_id, v_today) then v_blockers := array_append(v_blockers, 'PERIOD_CLOSED'); end if;
    if s.status <> 'activa' then v_blockers := array_append(v_blockers, 'CREDIT_NOT_ACTIVE'); end if;
    if s.balance_minor < p.amount_minor then v_blockers := array_append(v_blockers, 'OVERPAYMENT'); end if;
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = v_company and e.operation_id = p.ledger_operation_id and e.amount_minor > 0 and a.kind in ('custody', 'admin');
    if v_receiver is null then
      v_blockers := array_append(v_blockers, 'LEGACY_PAYMENTS');
    elsif v_rkind = 'custody' then
      if not adex.capital_custodian_ok(v_company, p.route_id, v_rmember) then v_blockers := array_append(v_blockers, 'CUSTODIAN_CHANGED'); end if;
      select * into rv from adex.payments where company_id = v_company and id = p.reversal_payment_id;
      select e.seq into v_rseq from adex.capital_entries e where e.company_id = v_company and e.operation_id = rv.ledger_operation_id and e.account_id = v_receiver;
      if exists (select 1 from adex.custody_settlements cs where cs.company_id = v_company and cs.custody_account_id = v_receiver
                   and cs.status = 'cerrada' and cs.to_seq >= v_rseq) then
        v_blockers := array_append(v_blockers, 'REVERSAL_SETTLED');
      end if;
    elsif v_rmember is distinct from adex.ctx_membership() then
      v_blockers := array_append(v_blockers, 'POOL_OF_ANOTHER_ADMIN');
    end if;
    return jsonb_build_object('paymentId', p.id, 'saleId', p.sale_id, 'amountMinor', p.amount_minor, 'paymentDate', p.payment_date,
      'reapplyDate', case when adex.capital_period_closed(v_company, p.route_id, p.payment_date) then v_today else p.payment_date end,
      'receiverKind', v_rkind, 'receiverId', v_rmember, 'blockers', to_jsonb(v_blockers));
  end $$;
revoke all on function adex.collection_reapply_check(text) from public;
grant execute on function adex.collection_reapply_check(text) to adex_api;
