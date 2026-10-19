-- ============================================================
-- 0016 · Reapertura de un periodo cerrado (CLEAN `reopenSettlement`)
-- ============================================================
-- La pantalla original de Liquidación permite REABRIR una semana cerrada: no borra ni
-- recalcula nada, marca el documento como 'reabierta' con quién, cuándo y por qué, y sus
-- fechas dejan de estar protegidas (los pagos vuelven a ser corregibles) hasta que se
-- cierre de nuevo, lo que crea una VERSIÓN nueva que sustituye a la reabierta (0014).
--
-- Reglas de CLEAN, segunda barrera aquí bajo bloqueo de la ruta:
--   · `settlement.reopen` en la ruta del documento;
--   · autoridad `correct` (v16): responsable de capital ACTUAL de la ruta o SuperAdmin;
--   · motivo de al menos 10 caracteres (MIN_REOPEN_REASON);
--   · solo un documento que protege (cerrado) y no sustituido.
-- El archivo de cifras del cierre (`period_closures`) no cambia: es historia.

create function adex.period_reopen(p_operation_id uuid, p_closure text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    w       adex.weekly_settlements%rowtype;
    v_ctrl  text;
    v_reason text := btrim(coalesce(p_reason, ''));
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('settlement.reopen') then perform adex.capital_raise('42501', 'no period reopen authority'); end if;
    select * into w from adex.weekly_settlements where company_id = x.company and id = p_closure;
    if not found or not adex.ctx_route_allowed(w.route_id) then perform adex.capital_raise('AX412', 'closure not found'); end if;
    -- Mismo bloqueo que el cierre: espera a lo que esté en curso en la ruta.
    perform 1 from adex.routes where company_id = x.company and id = w.route_id for update;
    select * into w from adex.weekly_settlements where company_id = x.company and id = p_closure for update;
    v_ctrl := adex.route_valid_controller(x.company, w.route_id);
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin reopens a period');
    end if;
    if length(v_reason) < 10 then perform adex.capital_raise('AX803', 'reason needs at least 10 characters'); end if;
    if length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is too long'); end if;
    if coalesce(w.status, 'cerrada') <> 'cerrada' then perform adex.capital_raise('AX806', 'only a closed period can be reopened'); end if;
    if w.superseded_by is not null then perform adex.capital_raise('AX806', 'this version was superseded'); end if;
    update adex.weekly_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = w.id;
    return jsonb_build_object('closureId', w.id, 'routeId', w.route_id, 'weekStart', w.week_start, 'weekEnd', w.week_end,
                              'version', coalesce(w.version, 1), 'status', 'reabierta');
  end $$;

revoke all on function adex.period_reopen(uuid, text, text) from public;
grant execute on function adex.period_reopen(uuid, text, text) to adex_api;
