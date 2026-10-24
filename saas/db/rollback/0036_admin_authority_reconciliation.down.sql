-- REVERSIÓN de 0036 (manual, como adex_owner, en una transacción). Intervención R74 §15 (RB-D1..D9).
-- Se NIEGA si existe cualquier dato de conciliación (filas en `difference_conciliations`, cuentas
-- `route_difference` u operaciones `DIFFERENCE_CONCILIATION`): revertir los perdería. Sin esos datos, 0036 no
-- cambió ninguna fila existente y la reversión deja el esquema idéntico al de 0035 (vuelven también las reglas
-- anteriores de desactivación, activación y anulación).
-- Restaura literalmente las funciones de 0034 y 0035.
-- Después: delete from adex_meta.schema_migrations where version = '0036'.
-- Generado por tmp/r74/w1/build-0036.mjs.

begin;

set local role adex_owner;

do $$
begin
  if exists (select 1 from adex.difference_conciliations)
     or exists (select 1 from adex.capital_accounts where kind = 'route_difference')
     or exists (select 1 from adex.capital_operations where kind = 'DIFFERENCE_CONCILIATION') then
    raise exception 'adex: 0036 cannot be reverted: conciliation data exists' using errcode = '55000';
  end if;
end $$;

drop policy admin_reimbursements_route_ctx on adex.admin_reimbursements;
drop policy expenses_general_route_ctx on adex.expenses;
drop policy capital_operations_conciliation_ctx on adex.capital_operations;
drop policy capital_accounts_route_difference_ctx on adex.capital_accounts;
drop trigger routes_controller_change_guard on adex.routes;
drop function adex.guard_route_controller_change();
drop trigger memberships_admin_deactivation_guard on adex.memberships;
drop function adex.guard_admin_deactivation();
drop function adex.admin_pending_accounts(text);
drop function adex.admin_pending_accounts_internal(text, text);
drop function adex.difference_resolve(uuid, text, text, text, bigint, text);
drop function adex.difference_preview(text, text, text);
drop function adex.route_difference_summary(text);
drop function adex.route_differences(text);

-- Funciones anteriores (texto literal de sus migraciones).

-- capital_lock_accounts: texto literal de 0035_general_expenses_funding.sql.
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding', 'admin_payable'], kind), id
      for update;
  end $$;

-- capital_ledger_checks: texto literal de 0035_general_expenses_funding.sql.
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

-- capital_model_prerequisites: texto literal de 0035_general_expenses_funding.sql.
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

-- capital_model_transition: texto literal de 0034_route_base.sql.
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
       where not (c->>'ok')::boolean and not (c->>'name' = 'company-account-zero' and v_note is not null);
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

-- route_period_figures: texto literal de 0034_route_base.sql.
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
             'otherMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL',
                              'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE', 'WORKER_DELIVERY', 'WORKER_RETURN', 'SETTLEMENT_RETURN', 'ROUTE_REASSIGNMENT', 'COLLECTION',
                              'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'ROUTE_EXPENSE')), 0),
             'closingMinor', coalesce(sum(amt) filter (where ak = 'route_base'), 0),
             'contributionsNetMinor', coalesce(-sum(amt) filter (where ak = 'route_funding'), 0))
      into v_base from legs;

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops, 'base', v_base);
  end $$;

-- custody_settlement_reopen: texto literal de 0034_route_base.sql.
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

-- expense_correctable: texto literal de 0035_general_expenses_funding.sql.
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

-- admin_reimbursement_reverse: texto literal de 0035_general_expenses_funding.sql.
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

-- route_panel: texto literal de 0035_general_expenses_funding.sql.
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

drop function adex.difference_resolutions(text, text, bigint);
drop function adex.difference_items_internal(text, text);
drop function adex.custody_worker_owed(text, text);
drop function adex.joint_operation_controllers(text[]);
drop function adex.require_controls_all_routes(text, text[], text);
drop function adex.general_funding_routes(text, text);
drop function adex.general_funding_in_scope(text, text, text);
drop table adex.difference_conciliations;

alter table adex.capital_operations drop constraint capital_operations_conciliation_shape;
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'));

alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable') or balance_minor >= 0);
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
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding', 'admin_payable'));

commit;
