-- ============================================================
-- 0038 · Cierre del periodo el mismo día (pedido del socio, 2026-10-25)
-- ============================================================
-- DECISIÓN DEL PROPIETARIO (2026-10-25): el responsable de capital puede cerrar un periodo que termina HOY
-- (fecha de la empresa, DS-04), normalmente el sábado o el domingo por la noche. Antes D29 solo dejaba cerrar
-- hasta ayer.
--
-- QUÉ CAMBIA: solo la regla D29, en sus dos lugares:
--   1. `adex.period_close`: AX804 pasa de `p_to >= hoy` a `p_to > hoy`.
--   2. La restricción de `adex.period_closures` (0014, sin nombre: `week_end < business_date`) pasa a
--      `week_end <= business_date` con nombre `period_closures_period_ended`. Las filas existentes ya la cumplen.
--   Un periodo que termina mañana o después sigue sin poder cerrarse.
--
-- QUÉ NO CAMBIA: un día cerrado sigue cerrado. Tras el cierre de hoy, cualquier movimiento nuevo de la ruta con
-- fecha de hoy (recaudo, gasto, venta, entrega, cuadre, sincronización sin conexión…) se rechaza con AX407 como
-- en cualquier periodo cerrado; se registra al día siguiente y entra en el próximo cierre. La interfaz lo avisa
-- antes de confirmar. Reabrir el periodo sigue igual. El resto de la función es la de 0033, sin cambios.
-- ============================================================

do $$
declare v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'adex.period_closures'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%week_end < business_date%';
  if v_name is null then raise exception '0038: no se encontró la restricción D29 de adex.period_closures'; end if;
  execute format('alter table adex.period_closures drop constraint %I', v_name);
end $$;
alter table adex.period_closures
  add constraint period_closures_period_ended check (week_start <= week_end and week_end <= business_date);   -- D29 (0038): hasta hoy

create or replace function adex.period_close(p_operation_id uuid, p_route text, p_from date, p_to date, p_note text) returns jsonb
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
    -- Autoridad `correct` (CLEAN `closeSettlement`): solo el responsable de capital (R74: no el SuperAdmin).
    if x.actor is distinct from v_ctrl then
      perform adex.capital_raise('AX402', 'only the route capital controller closes the period');
    end if;
    -- D29 con el reloj del servidor y la zona de la empresa (DS-04). 0038: el periodo puede terminar HOY
    -- (cierre del mismo día); lo que se registre después en la ruta va al día siguiente (AX407 hasta mañana).
    if p_to > x.today then perform adex.capital_raise('AX804', 'the period has not ended yet'); end if;
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
