-- ============================================================
-- 0030 · Ronda 73 · Parcelas en la autorización (SOC-04) y rectificación de créditos
--        desembolsados (SOC-09)
-- ------------------------------------------------------------
-- Pendiente de autorización del propietario para aplicarse en el PostgreSQL gestionado.
-- Solo AÑADE: columnas nullable, una tabla, un tipo de operación, funciones y políticas.
-- No modifica ni borra ninguna fila existente.
--
-- A. SOC-04 · El autorizador puede cambiar el NÚMERO DE PARCELAS antes de aprobar (con
--    `authorization.modifyConditions`, igual que la tasa, la frecuencia y los días). La
--    solicitud conserva lo pedido (`requested_installments_count`) y lo aprobado
--    (`approved_installments_count`). Las dos columnas las rellena el guardián: una API
--    anterior a esta migración sigue funcionando sin conocerlas. En solicitudes previas a
--    0030 ambas quedan NULL y la vista usa `installments_count` (nunca cambió antes de 0030).
--
-- B. SOC-09 · Rectificación de un crédito YA DESEMBOLSADO (decisión del propietario,
--    Ronda 73): solo el ADMINISTRADOR, solo si el crédito no tiene recaudos, su
--    desembolso no entró en un cuadre ni en un periodo cerrado, y quien pagó sigue
--    pudiendo responder del efectivo. Corrige capital, interés, parcelas y calendario.
--      · El asiento original (LOAN_DISBURSEMENT) NO se toca: la diferencia de capital
--        entre lo registrado y lo realmente entregado se registra como una operación
--        nueva `DISBURSEMENT_ADJUSTMENT`, con fecha de HOY, entre la MISMA cuenta que
--        pagó (custodia del trabajador o bolsa del Administrador) y la cartera de la ruta.
--        Δ > 0: salió más efectivo del registrado (exige saldo, sin faltante arrastrado).
--        Δ < 0: salió menos; el efectivo sigue en la cuenta que pagó.
--        Δ = 0 (solo interés, parcelas o calendario): ningún movimiento de dinero.
--      · El crédito conserva id, fecha y hora del desembolso, asiento y solicitud.
--      · Las cuotas (sin pagos) toman el calendario corregido EN SU MISMA FILA y las que
--        falten se añaden; las condiciones anteriores quedan COMPLETAS en la rectificación
--        (`before_state`). Ninguna cuota se borra (0002): REDUCIR el número de parcelas de
--        un crédito desembolsado queda bloqueado (AX525) hasta que el propietario decida.
--      · `adex.credit_rectifications` (append-only) guarda antes, después, Δ, motivo,
--        evidencia, Administrador, fecha contable y transacción.
--    No se implementa ninguna excepción de conciliación ni anulación (fuera de alcance).
-- ============================================================

-- ============================================================
-- A. SOC-04 · parcelas modificables en la autorización
-- ============================================================
alter table adex.sale_requests
  add column requested_installments_count integer check (requested_installments_count is null or requested_installments_count between 1 and 1000),
  add column approved_installments_count  integer check (approved_installments_count is null or approved_installments_count between 1 and 1000);

comment on column adex.sale_requests.requested_installments_count is 'Parcelas pedidas (Ronda 73, lo rellena el guardián al crear). NULL = solicitud anterior a 0030: lo pedido es installments_count.';
comment on column adex.sale_requests.approved_installments_count is 'Parcelas aprobadas (Ronda 73, lo rellena el guardián al aprobar).';

-- Guardián de 0018 con las parcelas (cambios marcados «Ronda 73»).
create or replace function adex.sale_requests_guard() returns trigger
  language plpgsql
  as $$
  declare
    v_role text := adex.ctx_role();
    -- Ronda 73: `installments_count` deja de ser inmutable (se fija al aprobar); lo pedido sí lo es.
    frozen text[] := array['id', 'company_id', 'client_id', 'route_id', 'collector_membership_id', 'amount_minor',
                           'start_date', 'requested_at', 'requested_by_membership_id', 'requested_interest_rate', 'requested_frequency',
                           'requested_payment_days', 'requested_installments_count', 'active_credit_sale_ids', 'active_credit_snapshot_units',
                           'authorization_reason'];
  begin
    -- La función de desembolso (propietario) es la única que pasa a 'disbursed'.
    if current_user <> 'adex_api' then
      if tg_op = 'UPDATE' and new.status = 'disbursed' and old.status <> 'approved' then
        raise exception 'adex: only an approved request is disbursed' using errcode = 'AX501';
      end if;
      return new;
    end if;
    if new.interest_rate not in (10, 20) then raise exception 'adex: interest rate must be 10 or 20' using errcode = 'AX502'; end if;
    if new.installments_count is null or new.installments_count not between 1 and 1000 then
      raise exception 'adex: invalid installments count' using errcode = 'AX503';
    end if;
    if new.total_amount_minor <> adex.credit_total(new.amount_minor, new.interest_rate)
       or new.installment_value_minor <> adex.credit_installment(new.total_amount_minor, new.installments_count) then
      raise exception 'adex: request totals do not match its conditions' using errcode = 'AX503';
    end if;
    if coalesce(cardinality(new.payment_days), 0) = 0 then raise exception 'adex: payment days are required' using errcode = 'AX503'; end if;
    if tg_op = 'INSERT' then
      -- Ronda 73: lo pedido lo fija el servidor (la API no lo envía).
      if new.requested_installments_count is not null and new.requested_installments_count <> new.installments_count then
        raise exception 'adex: a new request is pending and made by its requester' using errcode = '42501';
      end if;
      new.requested_installments_count := new.installments_count;
      new.approved_installments_count := null;
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
        if (new.interest_rate, new.frequency, new.payment_days, new.installments_count)
           is distinct from (old.interest_rate, old.frequency, old.payment_days, old.installments_count)
           and not adex.ctx_can('authorization.modifyConditions') then
          raise exception 'adex: changing conditions needs its authority' using errcode = '42501';
        end if;
        if coalesce(new.phone_confirmed, false) and not coalesce(old.phone_confirmed, false) and not adex.ctx_can('authorization.phoneConfirm') then
          raise exception 'adex: phone confirmation needs its authority' using errcode = '42501';
        end if;
        if (new.approved_interest_rate, new.approved_frequency, new.approved_payment_days) is distinct from (new.interest_rate, new.frequency, new.payment_days) then
          raise exception 'adex: approved conditions must be the final ones' using errcode = 'AX503';
        end if;
        -- Ronda 73: las parcelas aprobadas son las finales (las fija el servidor).
        new.approved_installments_count := new.installments_count;
        if old.requested_installments_count is null then new.requested_installments_count := old.installments_count; end if;
      else
        if not adex.ctx_can('authorization.reject') or length(btrim(coalesce(new.rejection_reason, ''))) = 0
           or (new.interest_rate, new.frequency, new.payment_days, new.installments_count)
              is distinct from (old.interest_rate, old.frequency, old.payment_days, old.installments_count) then
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

-- La API fija el número de parcelas al aprobar.
grant update (installments_count) on adex.sale_requests to adex_api;

-- ============================================================
-- B. SOC-09 · rectificación de créditos desembolsados
-- ============================================================

-- ---------- Libro: tipo de operación de ajuste del desembolso ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT'));
-- El ajuste pertenece a un crédito (como su desembolso y sus recaudos). Nunca se anula: una
-- rectificación equivocada se corrige con otra rectificación, en las mismas condiciones.
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT')) = (sale_id is not null));

-- Quien custodia (o el Administrador de la bolsa) ve el ajuste de su cuenta, como el desembolso.
alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text, 'DISBURSEMENT_ADJUSTMENT'::text])) AND ((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text) OR (( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((to_route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)))))))));

-- ---------- Crédito: contador de rectificaciones (concurrencia optimista) ----------
alter table adex.sales add column rectification_count integer not null default 0 check (rectification_count >= 0);
comment on column adex.sales.rectification_count is 'Rectificaciones aplicadas (Ronda 73, SOC-09). Quien rectifica envía el valor que vio: si cambió, 409.';

-- ---------- Historial de rectificaciones (append-only) ----------
create table adex.credit_rectifications (
  id                      adex.eid primary key,
  company_id              adex.eid not null references adex.companies(id),
  sale_id                 adex.eid not null,
  route_id                adex.eid not null,
  operation_id            uuid not null,                  -- idempotencia del comando
  sequence_no             integer not null check (sequence_no >= 1),
  adjustment_operation_id adex.eid,                       -- NULL si el capital no cambió
  delta_minor             bigint not null,                -- capital nuevo − capital anterior (con signo)
  payer_account_id        adex.eid not null,              -- la cuenta que pagó el desembolso original
  before_state            jsonb not null,                 -- crédito y cuotas completos ANTES
  after_state             jsonb not null,                 -- crédito y cuotas DESPUÉS
  reason                  text not null check (length(btrim(reason)) >= 10 and length(reason) <= 300),
  evidence                text not null check (length(btrim(evidence)) >= 10 and length(evidence) <= 500),
  offline_checked         boolean not null check (offline_checked),
  actor_membership_id     adex.eid not null,
  actor_identity_id       uuid not null,
  actor_role              text not null check (actor_role = 'admin'),
  business_date           date not null,
  txid                    bigint not null,
  created_at              timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, operation_id),
  unique (company_id, sale_id, sequence_no),
  check ((delta_minor = 0) = (adjustment_operation_id is null)),
  foreign key (company_id, sale_id) references adex.sales(company_id, id),
  foreign key (company_id, adjustment_operation_id) references adex.capital_operations(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
create index credit_rectifications_sale on adex.credit_rectifications (company_id, sale_id, sequence_no);
alter table adex.credit_rectifications enable row level security;
alter table adex.credit_rectifications force row level security;
create trigger credit_rectifications_immutable before update or delete on adex.credit_rectifications
  for each row execute function adex.reject_mutation();
create trigger credit_rectifications_no_truncate before truncate on adex.credit_rectifications
  for each statement execute function adex.reject_mutation();
-- Lectura: quien gestiona la cartera de la ruta (Admin y SuperAdmin con la ruta en su alcance).
create policy credit_rectifications_ctx on adex.credit_rectifications for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and (select adex.ctx_is(array['superadmin', 'admin']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
create policy owner_credit_rectifications on adex.credit_rectifications for insert to adex_owner with check (true);
grant select on adex.credit_rectifications to adex_api;
revoke all on adex.credit_rectifications from public;

-- ---------- Comando ----------
create function adex.credit_rectify(
  p_operation_id   uuid,
  p_sale           text,
  p_expected_count integer,     -- rectificaciones que vio quien rectifica (concurrencia optimista)
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,       -- [{ "number": 1, "dueDate": "YYYY-MM-DD", "amountMinor": 0 }, …] (motor de CLEAN)
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
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are rectified only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    -- Decisión del propietario (Ronda 73): solo el Administrador.
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    if p_operation_id is null or p_sale is null then perform adex.capital_raise('AX411', 'operation id and credit are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id)
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

    -- Orden de bloqueos (el de `credit_disburse` y los recaudos): ruta → crédito → cuentas.
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
    -- Sin recaudos: ningún pago (tampoco anulado o corregido) ni cuota con abonos.
    if exists (select 1 from adex.payments p where p.company_id = v_company and p.sale_id = s.id)
       or exists (select 1 from adex.installments x where x.company_id = v_company and x.sale_id = s.id and x.paid_minor <> 0)
       or s.balance_minor <> s.total_value_minor then
      perform adex.capital_raise('AX520', 'the credit already has collections');
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

    -- El desembolso no entró en un cuadre vigente de la custodia que pagó.
    if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs
         where cs.company_id = v_company and cs.custody_account_id = v_payer and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
      perform adex.capital_raise('AX521', 'the disbursement is already included in a settlement');
    end if;
    -- Ningún periodo cerrado: ni el del desembolso, ni el del calendario anterior o nuevo, ni hoy.
    if adex.capital_period_closed(v_company, v_route, v_orig.entry_date) or adex.capital_period_closed(v_company, v_route, s.disbursement_date)
       or adex.capital_period_closed(v_company, v_route, s.start_date) or adex.capital_period_closed(v_company, v_route, p_start)
       or adex.capital_period_closed(v_company, v_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;
    -- Quien respondió del efectivo sigue pudiendo hacerlo; la bolsa solo la mueve su Administrador.
    if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, v_route, v_powner) then
      perform adex.capital_raise('AX522', 'the worker who paid no longer holds cash in this route');
    end if;
    if v_pkind = 'admin' and v_powner is distinct from v_actor then
      perform adex.capital_raise('AX402', 'only the administrator whose pool paid rectifies this credit');
    end if;

    -- Condiciones nuevas (mismas reglas que el desembolso; el inicio no antecede al desembolso).
    if p_amount is null or p_amount <= 0 or p_count is null or p_count not between 1 and 1000 or p_frequency is null
       or p_frequency not in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada') or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 or p_start < coalesce(s.disbursement_date, v_orig.entry_date) then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
    -- Las cuotas no se borran (0002): reducir su número exige una decisión del propietario
    -- (p. ej. un estado «anulada» que el motor de recaudos ignore). Bloqueado en esta ronda.
    if p_count < s.installments_count then perform adex.capital_raise('AX525', 'fewer installments than the disbursed credit needs an owner decision'); end if;
    if (p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
       is not distinct from (s.sale_value_minor, s.interest_rate, s.installments_count, s.payment_frequency, s.start_date, s.payment_days) then
      perform adex.capital_raise('AX524', 'nothing to rectify');
    end if;
    v_total := adex.credit_total(p_amount, p_rate);
    v_value := adex.credit_installment(v_total, p_count);
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
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id));

    -- Diferencia de capital: operación nueva entre la cuenta que pagó y la cartera.
    v_delta := p_amount - s.sale_value_minor;
    if v_delta <> 0 then
      v_portf := adex.capital_account_for(v_company, 'portfolio', null, v_route);
      perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
        order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified'], kind), id for update;
      if v_delta > 0 then
        select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
        -- D25: un faltante arrastrado es deuda, no billetes.
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

    -- Cuotas (sin pagos): la misma fila de cada número se actualiza y las nuevas se añaden; las
    -- condiciones anteriores quedan completas en `before_state`. Nunca se borra una cuota (0002).
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      update adex.installments set due_date = i.d, amount_minor = i.a, paid_minor = 0, balance_minor = i.a, status = 'pendiente', days_overdue = 0
       where company_id = v_company and sale_id = s.id and number = i.n;
      if not found then
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, v_company, s.id, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
      end if;
    end loop;

    -- Crédito: condiciones corregidas; fecha, hora, asiento y solicitud del desembolso intactos.
    update adex.sales set sale_value_minor = p_amount, interest_rate = p_rate, interest_value_minor = v_total - p_amount, total_value_minor = v_total,
                          balance_minor = v_total, installments_count = p_count, installment_value_minor = v_value, payment_frequency = p_frequency,
                          payment_days = p_payment_days, start_date = p_start, estimated_end_date = v_end,
                          rectification_count = rectification_count + 1, updated_at = now()
     where company_id = v_company and id = s.id returning * into s;
    v_after := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id));

    insert into adex.credit_rectifications (id, company_id, sale_id, route_id, operation_id, sequence_no, adjustment_operation_id, delta_minor,
                                            payer_account_id, before_state, after_state, reason, evidence, offline_checked,
                                            actor_membership_id, actor_identity_id, actor_role, business_date, txid)
    values (v_rect, v_company, s.id, v_route, p_operation_id, s.rectification_count, v_adj, v_delta, v_payer, v_before, v_after,
            btrim(p_reason), btrim(p_evidence), true, v_actor, v_identity, v_role, v_today, txid_current());
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

revoke all on function adex.credit_rectify(uuid, text, integer, bigint, numeric, integer, text, date, smallint[], jsonb, text, text, boolean) from public;
grant execute on function adex.credit_rectify(uuid, text, integer, bigint, numeric, integer, text, date, smallint[], jsonb, text, text, boolean) to adex_api;

-- ---------- Cuadres y periodos: el ajuste cuenta como desembolso (no como «otros») ----------
-- Solo cambia la clasificación de las cifras: la posición de la custodia ya suma todas las
-- patas. Ningún cuadre ni cierre existente contiene este tipo nuevo: sus cifras no cambian.
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
           coalesce(-sum(e.amount_minor) filter (where k.b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0)::bigint,
           coalesce(-sum(e.amount_minor) filter (where k.b = 'WORKER_EXPENSE'), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                 'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'WORKER_EXPENSE')), 0)::bigint,
           count(*)::int
      from adex.capital_entries e
      join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
      cross join lateral (select coalesce(o.reverses_kind, o.kind) as b) k
     where e.company_id = p_company and e.account_id = p_account and e.seq > p_from and e.seq <= p_to
  $$;

-- `route_period_figures` de 0014 con el ajuste en desembolsos (única diferencia).
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
