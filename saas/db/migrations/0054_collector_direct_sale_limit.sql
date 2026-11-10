-- 0054: venta directa del Cobrador hasta un monto configurado en la ruta (decisión de Helmer, 2026-11-09).
--
-- Hasta hoy el Cobrador SIEMPRE enviaba solicitud (decisión 2026-09-24). Ahora cada ruta puede definir
-- «Venta sin autorización hasta» (`collector_direct_max_minor`, 0 = desactivado, como antes). Con el valor
-- configurado, una venta del Cobrador de esa ruta queda entregada al instante si:
--   · su valor es <= ese monto (y <= el «Monto máx. de venta» de la ruta, que sigue aparte);
--   · el cliente NO tiene un crédito vivo (renovación o segundo crédito: siguen con autorización);
--   · la tasa es la permitida por la ruta (lo valida la API, D73-01);
--   · el dinero sale del efectivo del Cobrador («Mi efectivo»), igual que al desembolsar una solicitud aprobada.
-- Solo en línea (las ventas sin conexión siguen prohibidas, Ronda 65-C1).

alter table adex.routes add column collector_direct_max_minor bigint not null default 0;
alter table adex.routes add constraint routes_collector_direct_max_nonneg check (collector_direct_max_minor >= 0);

grant insert (collector_direct_max_minor) on adex.routes to adex_api;
grant update (collector_direct_max_minor) on adex.routes to adex_api;

-- credit_disburse: la venta directa admite al Cobrador dentro del monto de su ruta. Se reescribe la definición
-- VIGENTE (0034 + 0049) cambiando solo la comprobación de autoridad de la venta directa.
do $$
declare
  f   regprocedure;
  def text;
  a1  constant text := 'if not adex.ctx_can(''sale.createDirect'') then perform adex.capital_raise(''AX402'', ''no direct sale authority''); end if;';
  b1  constant text := 'if not adex.ctx_can(''sale.createDirect'') then
        -- 0054: el Cobrador vende directo solo dentro del monto de su ruta y a un cliente sin crédito vivo.
        if v_role <> ''cobrador'' then perform adex.capital_raise(''AX402'', ''no direct sale authority''); end if;
        if not exists (select 1 from adex.routes r where r.company_id = v_company and r.id = p_route
                          and r.collector_direct_max_minor > 0 and p_amount <= r.collector_direct_max_minor
                          and (r.max_loan_minor = 0 or p_amount <= r.max_loan_minor)) then
          perform adex.capital_raise(''AX507'', ''over the collector direct sale limit: send it as a request'');
        end if;
        if exists (select 1 from adex.client_active_credits(v_company, p_client)) then
          perform adex.capital_raise(''AX507'', ''the client has an active credit: send it as a request'');
        end if;
      end if;';
begin
  select p.oid::regprocedure into strict f from pg_proc p
   where p.pronamespace = 'adex'::regnamespace and p.proname = 'credit_disburse';
  def := pg_get_functiondef(f);
  if (length(def) - length(replace(def, a1, ''))) / length(a1) <> 1 then
    raise exception '0054: credit_disburse should contain the direct sale authority check exactly once';
  end if;
  execute replace(def, a1, b1);
end $$;
