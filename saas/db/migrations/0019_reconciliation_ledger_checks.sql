-- 0019 · Conciliación de capital: comprobaciones del libro en una sola función.
--
-- Las comprobaciones que recorren el libro (patas por cuenta, por operación, por cuadre y
-- las cifras de cada periodo cerrado) evaluaban la política RLS fila a fila como `adex_api`:
-- con seis meses de operación superaban el tope de 2 min por sentencia del rol. Aquí se
-- ejecutan como el propietario del esquema, con las MISMAS consultas y el mismo resultado,
-- y solo para quien ya ve todo ese libro: el SuperAdmin activo de la empresa del contexto
-- (`capital.allocateAdmins`). Nadie más puede llamarla; no escribe nada.
--
-- Única diferencia de forma: las cifras de cada periodo cerrado se calculan UNA vez por
-- cierre (antes, dos), comparando las mismas dos partes (custodia y huella de operaciones).

create function adex.capital_ledger_checks() returns jsonb
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
                         and (p.figures -> 'custody' is distinct from now.f -> 'custody' or p.ledger_hash is distinct from now.f #>> '{operations,hash}')))
      into r;
    return r;
  end $$;
revoke all on function adex.capital_ledger_checks() from public;
grant execute on function adex.capital_ledger_checks() to adex_api;
