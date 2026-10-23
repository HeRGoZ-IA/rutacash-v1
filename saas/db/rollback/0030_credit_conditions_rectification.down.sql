-- REVERSIÓN de 0030 (manual, como adex_owner, en una transacción). Ronda 73.
-- SOLO si todavía no hubo rectificaciones, casos, ajustes, cuotas sustituidas ni parcelas cambiadas al
-- aprobar: en ese caso se detiene sin tocar nada (lo financiero ya registrado se corrige hacia adelante,
-- nunca se borra). Restaura literalmente las funciones, la política y las restricciones anteriores
-- (0013, 0014, 0018, 0023, 0002) y retira lo añadido por 0030.
-- Después: delete from adex_meta.schema_migrations where version = '0030'.

begin;

set local role adex_owner;

do $$ begin
  if exists (select 1 from adex.credit_rectifications) or exists (select 1 from adex.credit_rectification_cases)
     or exists (select 1 from adex.capital_operations where kind = 'DISBURSEMENT_ADJUSTMENT' or reverses_kind = 'DISBURSEMENT_ADJUSTMENT')
     or exists (select 1 from adex.installments where status = 'sustituida')
     or exists (select 1 from adex.sale_requests where requested_installments_count is not null and requested_installments_count <> installments_count) then
    raise exception 'adex: 0030 ya tiene uso registrado (rectificaciones, casos o parcelas cambiadas): no se revierte; corregir hacia adelante';
  end if;
end $$;

-- Funciones anteriores (texto literal de sus migraciones).
create or replace function adex.sale_requests_guard() returns trigger
  language plpgsql
  as $$
  declare
    v_role text := adex.ctx_role();
    frozen text[] := array['id', 'company_id', 'client_id', 'route_id', 'collector_membership_id', 'amount_minor', 'installments_count',
                           'start_date', 'requested_at', 'requested_by_membership_id', 'requested_interest_rate', 'requested_frequency',
                           'requested_payment_days', 'active_credit_sale_ids', 'active_credit_snapshot_units', 'authorization_reason'];
  begin
    -- La función de desembolso (propietario) es la única que pasa a 'disbursed'.
    if current_user <> 'adex_api' then
      if tg_op = 'UPDATE' and new.status = 'disbursed' and old.status <> 'approved' then
        raise exception 'adex: only an approved request is disbursed' using errcode = 'AX501';
      end if;
      return new;
    end if;
    if new.interest_rate not in (10, 20) then raise exception 'adex: interest rate must be 10 or 20' using errcode = 'AX502'; end if;
    if new.total_amount_minor <> adex.credit_total(new.amount_minor, new.interest_rate)
       or new.installment_value_minor <> adex.credit_installment(new.total_amount_minor, new.installments_count) then
      raise exception 'adex: request totals do not match its conditions' using errcode = 'AX503';
    end if;
    if coalesce(cardinality(new.payment_days), 0) = 0 then raise exception 'adex: payment days are required' using errcode = 'AX503'; end if;
    if tg_op = 'INSERT' then
      if new.status <> 'pending' or new.requested_by_membership_id is distinct from adex.ctx_membership()
         or new.collector_membership_id is distinct from adex.ctx_membership()
         or new.reviewed_at is not null or new.reviewed_by_membership_id is not null or new.sale_id is not null
         or (new.requested_interest_rate, new.requested_frequency, new.requested_payment_days)
            is distinct from (new.interest_rate, new.frequency, new.payment_days) then
        raise exception 'adex: a new request is pending and made by its requester' using errcode = '42501';
      end if;
      -- El Cobrador solo origina al 20 % (`originationRatesFor`).
      if v_role = 'cobrador' and new.interest_rate <> 20 then raise exception 'adex: the Cobrador originates only at 20%%' using errcode = 'AX502'; end if;
      if new.start_date < adex.business_today(new.company_id) then
        raise exception 'adex: start date before today' using errcode = 'AX503';
      end if;
      if not exists (select 1 from adex.clients c where c.company_id = new.company_id and c.id = new.client_id and c.route_id = new.route_id and c.status = 'activo') then
        raise exception 'adex: the client is not active in this route' using errcode = 'AX504';
      end if;
      return new;
    end if;
    -- UPDATE por la API: resolver o cancelar.
    if exists (select 1 from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
                where n.key = any(frozen) and n.value is distinct from o.value) then
      raise exception 'adex: request facts are immutable' using errcode = '42501';
    end if;
    if old.status = 'pending' and new.status in ('approved', 'rejected') then
      if new.reviewed_by_membership_id is distinct from adex.ctx_membership() or new.reviewed_at is null then
        raise exception 'adex: the reviewer is the active membership' using errcode = '42501';
      end if;
      if adex.same_person(new.company_id, new.reviewed_by_membership_id, coalesce(old.requested_by_membership_id, old.collector_membership_id)) then
        raise exception 'adex: nobody resolves their own request' using errcode = 'AX505';
      end if;
      if new.status = 'approved' then
        if not adex.ctx_can('authorization.approve') then raise exception 'adex: no approval authority' using errcode = '42501'; end if;
        if (new.interest_rate, new.frequency, new.payment_days) is distinct from (old.interest_rate, old.frequency, old.payment_days)
           and not adex.ctx_can('authorization.modifyConditions') then
          raise exception 'adex: changing conditions needs its authority' using errcode = '42501';
        end if;
        if coalesce(new.phone_confirmed, false) and not coalesce(old.phone_confirmed, false) and not adex.ctx_can('authorization.phoneConfirm') then
          raise exception 'adex: phone confirmation needs its authority' using errcode = '42501';
        end if;
        if (new.approved_interest_rate, new.approved_frequency, new.approved_payment_days) is distinct from (new.interest_rate, new.frequency, new.payment_days) then
          raise exception 'adex: approved conditions must be the final ones' using errcode = 'AX503';
        end if;
      else
        if not adex.ctx_can('authorization.reject') or length(btrim(coalesce(new.rejection_reason, ''))) = 0
           or (new.interest_rate, new.frequency, new.payment_days) is distinct from (old.interest_rate, old.frequency, old.payment_days) then
          raise exception 'adex: invalid rejection' using errcode = '42501';
        end if;
      end if;
      return new;
    end if;
    if old.status = 'approved' and new.status = 'cancelled' then
      if not adex.ctx_can('sale.cancel') or new.cancelled_by_membership_id is distinct from adex.ctx_membership() or new.cancelled_at is null
         or (to_jsonb(new) - array['status', 'cancelled_at', 'cancelled_by_membership_id', 'cancel_reason'])
            is distinct from (to_jsonb(old) - array['status', 'cancelled_at', 'cancelled_by_membership_id', 'cancel_reason']) then
        raise exception 'adex: invalid cancellation' using errcode = '42501';
      end if;
      return new;
    end if;
    raise exception 'adex: request cannot go from % to %', old.status, new.status using errcode = 'AX501';
  end $$;

create or replace function adex.credit_recompute(p_company text, p_sale text, p_today date, p_paid_on date) returns bigint
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

create or replace function adex.custody_cycle(p_company text, p_account text, p_from bigint, p_to bigint) returns adex.custody_cycle_t
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

-- Política de lectura de operaciones de 0023.
alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text])) AND ((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text) OR (( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((to_route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)))))))));

-- Restricciones anteriores.
alter table adex.installments drop constraint installments_substituted_zero;
alter table adex.installments drop constraint installments_status_check;
alter table adex.installments add constraint installments_status_check check (status in ('pendiente', 'parcial', 'pagada', 'vencida', 'adelantada'));
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE'));

-- Lo añadido por 0030.
drop function adex.credit_rectify(uuid, text, integer, bigint, numeric, integer, text, date, smallint[], jsonb, text, text, boolean);
drop function adex.credit_rectify_check(text);
drop table adex.credit_rectification_cases;
drop table adex.credit_rectifications;
alter table adex.sales drop column rectification_count;
revoke update (installments_count) on adex.sale_requests from adex_api;
alter table adex.sale_requests drop column requested_installments_count, drop column approved_installments_count;

commit;
