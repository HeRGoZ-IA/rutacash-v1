-- ============================================================
-- ADEX SaaS · Fase 0 · 0002 · Modelo operativo y financiero (Dexie v16)
-- ------------------------------------------------------------
-- Clientes, solicitudes, ventas, parcelas, pagos, visitas, gastos, capital,
-- transferencias, retiros, Caja socios, cuadres, custodia, cierres, libro de
-- capital por Administrador (v16), auditoría e idempotencia.
--
-- Esta migración NO implementa comandos financieros: define dónde vive cada dato
-- y las restricciones ESTRUCTURALES que ninguna escritura futura podrá saltarse:
--   · aislamiento por empresa con FK compuestas;
--   · importes enteros (unidades menores) y signo coherente con su asiento;
--   · inmutabilidad de lo financiero (D7, D28): sin DELETE, asientos espejo para
--     anular, cierres versionados, transiciones de pago monótonas;
--   · forma de cada movimiento de custodia y de cada gasto clasificado.
--
-- Las reglas que dependen de saldos (D24–D26, D30, bolsas) son de los comandos de
-- las fases 3–6 y se prueban con las suites existentes contra el servidor.
-- ============================================================

-- ---------- Clientes ----------
create table adex.clients (
  id                  adex.eid primary key,
  company_id          adex.eid not null references adex.companies(id),
  route_id            adex.eid not null,
  name                text not null,
  document            text not null,
  phone_primary       text not null,
  phone_secondary     text,
  address_primary     text not null,
  address_secondary   text,
  business            text,
  document_photo_url  text,
  business_photo_url  text,
  status              text not null check (status in ('activo', 'inactivo', 'moroso', 'perdido')),
  notes               text,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  unique (company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id)
);
-- DS-10 (documento único por empresa) está ABIERTA: solo índice, sin unicidad.
create index clients_company_document on adex.clients (company_id, document);
create index clients_route on adex.clients (company_id, route_id);

-- ---------- Solicitudes de venta ----------
create table adex.sale_requests (
  id                            adex.eid primary key,
  company_id                    adex.eid not null references adex.companies(id),
  client_id                     adex.eid not null,
  route_id                      adex.eid not null,
  collector_membership_id       adex.eid not null,
  amount_minor                  bigint not null check (amount_minor > 0),
  interest_rate                 numeric(9, 4) not null check (interest_rate >= 0),
  total_amount_minor            bigint not null check (total_amount_minor > 0),
  installments_count            integer not null check (installments_count > 0),
  installment_value_minor       bigint not null check (installment_value_minor > 0),
  frequency                     text not null check (frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  start_date                    date not null,
  payment_days                  smallint[] check (payment_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  status                        text not null check (status in ('pending', 'approved', 'rejected', 'disbursed', 'cancelled')),
  requested_at                  timestamptz not null,
  reviewed_at                   timestamptz,
  reviewed_by_membership_id     adex.eid,
  rejection_reason              text,
  approval_notes                text,
  sale_id                       adex.eid,
  requested_by_membership_id    adex.eid,
  requested_interest_rate       numeric(9, 4),
  requested_frequency           text check (requested_frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  requested_payment_days        smallint[],
  approved_interest_rate        numeric(9, 4),
  approved_frequency            text check (approved_frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  approved_payment_days         smallint[],
  phone_confirmed               boolean,
  phone_confirmation_note       text,
  active_credit_sale_ids        text[],
  -- Fotografía congelada tal cual (importes en UNIDADES de la moneda, como en Dexie).
  active_credit_snapshot_units  jsonb,
  authorization_reason          text check (authorization_reason in ('active-credit', 'no-direct-capability', 'over-limit')),
  unique (company_id, id),
  foreign key (company_id, client_id)                  references adex.clients(company_id, id),
  foreign key (company_id, route_id)                   references adex.routes(company_id, id),
  foreign key (company_id, collector_membership_id)    references adex.memberships(company_id, id),
  foreign key (company_id, reviewed_by_membership_id)  references adex.memberships(company_id, id),
  foreign key (company_id, requested_by_membership_id) references adex.memberships(company_id, id)
);
-- Una sola solicitud pendiente por cliente (regla de `createSaleRequest`, [T] activecredit).
create unique index sale_requests_one_pending_per_client
  on adex.sale_requests (company_id, client_id) where status = 'pending';
create index sale_requests_route on adex.sale_requests (company_id, route_id, status);

-- ---------- Ventas (créditos) ----------
create table adex.sales (
  id                              adex.eid primary key,
  company_id                      adex.eid not null references adex.companies(id),
  route_id                        adex.eid not null,
  client_id                       adex.eid not null,
  created_by_membership_id        adex.eid not null,
  sale_value_minor                bigint not null check (sale_value_minor > 0),
  interest_rate                   numeric(9, 4) not null check (interest_rate >= 0),
  interest_value_minor            bigint not null check (interest_value_minor >= 0),
  total_value_minor               bigint not null check (total_value_minor > 0),
  balance_minor                   bigint not null check (balance_minor >= 0),   -- nunca saldo negativo
  installments_count              integer not null check (installments_count > 0),
  installment_value_minor         bigint not null check (installment_value_minor > 0),
  payment_frequency               text not null check (payment_frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  payment_days                    smallint[] check (payment_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_date                      date not null,
  estimated_end_date              date not null,
  finished_on                     date,
  status                          text not null check (status in ('activa', 'finalizada', 'perdida', 'refinanciada')),
  -- NULL = venta antigua, tratada como desembolsada (compatibilidad documentada).
  disbursement_status             text check (disbursement_status in ('pendiente', 'desembolsado')),
  disbursed_by_collector_id       adex.eid,
  disbursed_by_membership_id      adex.eid,
  disbursement_date               date,
  disbursed_at                    timestamptz,
  sale_request_id                 adex.eid,
  lost_reason                     text,
  lost_at                         timestamptz,              -- D28: castigar no borra la historia
  lost_by_membership_id           adex.eid,
  created_at                      timestamptz not null,
  updated_at                      timestamptz not null,
  unique (company_id, id),
  -- Una solicitud origina como máximo una venta.
  unique (company_id, sale_request_id),
  foreign key (company_id, route_id)                   references adex.routes(company_id, id),
  foreign key (company_id, client_id)                  references adex.clients(company_id, id),
  foreign key (company_id, created_by_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, disbursed_by_collector_id)  references adex.memberships(company_id, id),
  foreign key (company_id, disbursed_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, lost_by_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, sale_request_id)            references adex.sale_requests(company_id, id) deferrable initially deferred
);
create index sales_route_status on adex.sales (company_id, route_id, status);
create index sales_client on adex.sales (company_id, client_id);

alter table adex.sale_requests
  add foreign key (company_id, sale_id) references adex.sales(company_id, id) deferrable initially deferred;

-- ---------- Parcelas ----------
-- `Installment` no tiene `tenantId` en Dexie: aquí se añade `company_id` (aislamiento)
-- y se deriva de la venta mediante la FK compuesta.
create table adex.installments (
  id               adex.eid primary key,
  company_id       adex.eid not null references adex.companies(id),
  sale_id          adex.eid not null,
  number           integer not null check (number > 0),
  due_date         date not null,
  amount_minor     bigint not null check (amount_minor >= 0),
  paid_minor       bigint not null check (paid_minor >= 0),
  balance_minor    bigint not null check (balance_minor >= 0),
  status           text not null check (status in ('pendiente', 'parcial', 'pagada', 'vencida', 'adelantada')),
  days_overdue     integer not null check (days_overdue >= 0),
  unique (company_id, id),
  unique (company_id, sale_id, number),
  foreign key (company_id, sale_id) references adex.sales(company_id, id)
);

-- ---------- Pagos ----------
create table adex.payments (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  sale_id                    adex.eid not null,
  client_id                  adex.eid not null,
  route_id                   adex.eid not null,
  collector_membership_id    adex.eid not null,     -- responsable del efectivo (D25)
  created_by_membership_id   adex.eid,              -- quién digitó (NULL = legado: igual a collector)
  amount_minor               bigint not null check (amount_minor <> 0),
  payment_date               date not null,
  payment_type               text not null check (payment_type in ('efectivo', 'transferencia', 'otro')),
  note                       text,
  lat                        double precision,
  lng                        double precision,
  sync_status                text not null check (sync_status in ('synced', 'pending', 'error')),
  created_at                 timestamptz not null,
  state                      text check (state in ('active', 'reversed', 'reversal', 'correction')),
  reverses_payment_id        adex.eid,
  corrected_by_payment_id    adex.eid,
  reversal_payment_id        adex.eid,
  correction_of_payment_id   adex.eid,
  correction_reason          text,
  corrected_by_membership_id adex.eid,
  corrected_at               timestamptz,
  unique (company_id, id),
  -- Un asiento de reversión anula un solo pago, y un pago tiene una sola reversión.
  unique (company_id, reverses_payment_id),
  check ((state = 'reversal') = (reverses_payment_id is not null)),
  check (state is distinct from 'reversal' or amount_minor < 0),
  check (coalesce(state, 'active') = 'reversal' or amount_minor > 0),
  foreign key (company_id, sale_id)                    references adex.sales(company_id, id),
  foreign key (company_id, client_id)                  references adex.clients(company_id, id),
  foreign key (company_id, route_id)                   references adex.routes(company_id, id),
  foreign key (company_id, collector_membership_id)    references adex.memberships(company_id, id),
  foreign key (company_id, created_by_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, corrected_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reverses_payment_id)        references adex.payments(company_id, id) deferrable initially deferred,
  foreign key (company_id, corrected_by_payment_id)    references adex.payments(company_id, id) deferrable initially deferred,
  foreign key (company_id, reversal_payment_id)        references adex.payments(company_id, id) deferrable initially deferred,
  foreign key (company_id, correction_of_payment_id)   references adex.payments(company_id, id) deferrable initially deferred
);
create index payments_sale on adex.payments (company_id, sale_id);
create index payments_route_date on adex.payments (company_id, route_id, payment_date);
create index payments_collector on adex.payments (company_id, collector_membership_id, created_at);

-- ---------- Solicitudes de ajuste de pago (periodo cerrado) ----------
create table adex.payment_adjustment_requests (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_id                    adex.eid not null,
  payment_id                  adex.eid not null,
  client_id                   adex.eid not null,
  sale_id                     adex.eid not null,
  requested_by_membership_id  adex.eid not null,
  requested_by_role           text not null check (requested_by_role in ('superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario')),
  requested_at                timestamptz not null,
  original_amount_minor       bigint not null,
  original_date               date not null,
  reason                      text not null check (length(btrim(reason)) > 0),
  new_amount_minor            bigint not null check (new_amount_minor >= 0),
  new_date                    date,
  note                        text,
  status                      text not null check (status in ('pending', 'approved', 'rejected')),
  reviewed_by_membership_id   adex.eid,
  reviewed_at                 timestamptz,
  rejection_reason            text,
  resulting_reversal_id       adex.eid,
  resulting_payment_id        adex.eid,
  unique (company_id, id),
  foreign key (company_id, route_id)                   references adex.routes(company_id, id),
  foreign key (company_id, payment_id)                 references adex.payments(company_id, id),
  foreign key (company_id, client_id)                  references adex.clients(company_id, id),
  foreign key (company_id, sale_id)                    references adex.sales(company_id, id),
  foreign key (company_id, requested_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reviewed_by_membership_id)  references adex.memberships(company_id, id),
  foreign key (company_id, resulting_reversal_id)      references adex.payments(company_id, id),
  foreign key (company_id, resulting_payment_id)       references adex.payments(company_id, id)
);

-- ---------- Visitas sin pago ----------
create table adex.no_payment_visits (
  id                       adex.eid primary key,
  company_id               adex.eid not null references adex.companies(id),
  sale_id                  adex.eid not null,
  client_id                adex.eid not null,
  route_id                 adex.eid not null,
  collector_membership_id  adex.eid not null,
  reason                   text not null check (reason in ('no_estaba', 'sin_dinero', 'negocio_cerrado', 'promesa_pago', 'otro')),
  promised_payment_date    date,
  note                     text,
  visit_date               date not null,
  sync_status              text not null check (sync_status in ('synced', 'pending', 'error')),
  created_at               timestamptz not null,
  unique (company_id, id),
  foreign key (company_id, sale_id)                 references adex.sales(company_id, id),
  foreign key (company_id, client_id)               references adex.clients(company_id, id),
  foreign key (company_id, route_id)                references adex.routes(company_id, id),
  foreign key (company_id, collector_membership_id) references adex.memberships(company_id, id)
);

-- ---------- Categorías de gasto ----------
create table adex.expense_categories (
  id         adex.eid primary key,
  company_id adex.eid not null references adex.companies(id),
  name       text not null,
  icon       text,
  active     boolean not null,
  unique (company_id, id)
);

-- ---------- Gastos (clasificados por atribución y bolsa) ----------
create table adex.expenses (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_id                    adex.eid,
  scope                       text check (scope in ('empresa', 'ruta', 'trabajador')),   -- NULL = histórico
  category_id                 adex.eid not null,
  amount_minor                bigint not null check (amount_minor <> 0),
  description                 text,
  receipt_photo_data_url      text,
  expense_date                date not null,
  registered_by_membership_id adex.eid not null,     -- `Expense.userId`
  collector_membership_id     adex.eid,
  funding                     text check (funding in ('admin', 'empresa')),               -- NULL = sin bolsa (histórico, D9)
  funding_admin_membership_id adex.eid,
  refunds_expense_id          adex.eid,
  reference                   text,
  sync_status                 text not null check (sync_status in ('synced', 'pending', 'error')),
  created_at                  timestamptz not null,
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  -- Un asiento negativo es una reversión o un reintegro; un gasto normal es positivo.
  check ((amount_minor < 0) = (reverses_id is not null or refunds_expense_id is not null)),
  -- Atribución económica (punto 9 de los ajustes del socio 2026-10-02).
  check (scope is distinct from 'empresa'    or (route_id is null and collector_membership_id is null)),
  check (scope is distinct from 'ruta'       or (route_id is not null and collector_membership_id is null)),
  check (scope is distinct from 'trabajador' or (route_id is not null and collector_membership_id is not null)),
  -- Bolsa: solo en gastos de empresa; la del Administrador exige su id.
  check (funding is null or scope = 'empresa'),
  check ((funding = 'admin') = (funding_admin_membership_id is not null)),
  foreign key (company_id, route_id)                    references adex.routes(company_id, id),
  foreign key (company_id, category_id)                 references adex.expense_categories(company_id, id),
  foreign key (company_id, registered_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, collector_membership_id)     references adex.memberships(company_id, id),
  foreign key (company_id, funding_admin_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, refunds_expense_id)          references adex.expenses(company_id, id) deferrable initially deferred,
  foreign key (company_id, reversal_id)                 references adex.expenses(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)                 references adex.expenses(company_id, id) deferrable initially deferred
);
create index expenses_route_date on adex.expenses (company_id, route_id, expense_date);

-- ---------- Capital colocado en la ruta (Admin → Ruta) ----------
create table adex.capital_movements (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  route_id                   adex.eid not null,
  kind                       text not null check (kind in ('ingresoCapital', 'ajusteCapital')),
  amount_minor               bigint not null check (amount_minor <> 0),
  description                text,
  movement_date              date not null,
  registered_by_membership_id adex.eid not null,
  created_at                 timestamptz not null,
  admin_membership_id        adex.eid,          -- bolsa de origen (v16); NULL = anterior a v16
  reversal_id                adex.eid,
  reversed_at                timestamptz,
  reversed_by_membership_id  adex.eid,
  reversal_reason            text,
  reverses_id                adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check (reverses_id is null or amount_minor < 0),
  foreign key (company_id, route_id)                    references adex.routes(company_id, id),
  foreign key (company_id, registered_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, admin_membership_id)         references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)                 references adex.capital_movements(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)                 references adex.capital_movements(company_id, id) deferrable initially deferred
);

-- ---------- Transferencias (Ruta↔Ruta, Ruta↔Socio, Socio↔Socio) ----------
create table adex.transfers (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_origin_id             adex.eid,          -- '' en Dexie cuando el origen es un socio → NULL
  route_destination_id        adex.eid,
  partner_origin_membership_id      adex.eid,
  partner_destination_membership_id adex.eid,
  origin_type                 text check (origin_type in ('route', 'partner')),
  destination_type            text check (destination_type in ('route', 'partner')),
  amount_minor                bigint not null check (amount_minor <> 0),
  description                 text,
  transfer_date               date not null,
  registered_by_membership_id adex.eid not null,
  created_at                  timestamptz not null,
  admin_membership_id         adex.eid,          -- responsable de ambas rutas (Ruta→Ruta, v16)
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check (reverses_id is null or amount_minor < 0),
  check (route_origin_id is not null or partner_origin_membership_id is not null),
  check (route_destination_id is not null or partner_destination_membership_id is not null),
  foreign key (company_id, route_origin_id)                   references adex.routes(company_id, id),
  foreign key (company_id, route_destination_id)              references adex.routes(company_id, id),
  foreign key (company_id, partner_origin_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, partner_destination_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, registered_by_membership_id)       references adex.memberships(company_id, id),
  foreign key (company_id, admin_membership_id)               references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id)         references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)                       references adex.transfers(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)                       references adex.transfers(company_id, id) deferrable initially deferred
);

-- ---------- Retiros (Ruta → bolsa del Administrador) ----------
create table adex.withdrawals (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_id                    adex.eid not null,
  amount_minor                bigint not null check (amount_minor <> 0),
  description                 text,
  withdrawal_date             date not null,
  registered_by_membership_id adex.eid not null,
  created_at                  timestamptz not null,
  admin_membership_id         adex.eid,
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check ((amount_minor < 0) = (reverses_id is not null)),
  foreign key (company_id, route_id)                    references adex.routes(company_id, id),
  foreign key (company_id, registered_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, admin_membership_id)         references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)                 references adex.withdrawals(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)                 references adex.withdrawals(company_id, id) deferrable initially deferred
);

-- ---------- Libro de capital por Administrador (v16) ----------
create table adex.capital_ledger (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  kind                        text not null check (kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'ROUTE_CONTROL_TRANSFER')),
  amount_minor                bigint not null,
  from_admin_membership_id    adex.eid,
  to_admin_membership_id      adex.eid,
  route_id                    adex.eid,
  related_event_id            adex.eid,
  description                 text,
  entry_date                  date not null,
  created_at                  timestamptz not null,
  -- `actorUserId`: una membresía o un actor de sistema (`system:migration-v16`).
  actor_membership_id         adex.eid,
  actor_system                text check (actor_system ~ '^system:[a-z0-9:._-]+$'),
  actor_role                  text check (actor_role in ('superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario', 'system')),
  status                      text not null check (status = 'aplicado'),
  sync_status                 text not null check (sync_status in ('synced', 'pending', 'error')),
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check ((actor_membership_id is null) <> (actor_system is null)),
  -- Entero > 0 salvo el traspaso de responsabilidad (neto, puede ser ≤ 0) y los storno.
  check (kind = 'ROUTE_CONTROL_TRANSFER'
         or (reverses_id is null and amount_minor > 0)
         or (reverses_id is not null and amount_minor < 0)),
  check (kind <> 'ROUTE_CONTROL_TRANSFER' or route_id is not null),
  foreign key (company_id, from_admin_membership_id)  references adex.memberships(company_id, id),
  foreign key (company_id, to_admin_membership_id)    references adex.memberships(company_id, id),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, actor_membership_id)       references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)               references adex.capital_ledger(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)               references adex.capital_ledger(company_id, id) deferrable initially deferred
);

-- ---------- Historial de responsables de capital (v16) ----------
create table adex.route_capital_controller_events (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_id                    adex.eid not null,
  kind                        text not null check (kind in ('MIGRATION', 'FIRST_ADMIN', 'CHANGE', 'RELEASE')),
  from_admin_membership_id    adex.eid,
  to_admin_membership_id      adex.eid,
  capital_transferred_minor   bigint not null,
  base_at_change_minor        bigint,
  ledger_entry_id             adex.eid,
  reason                      text,
  created_at                  timestamptz not null,
  actor_membership_id         adex.eid,
  actor_system                text check (actor_system ~ '^system:[a-z0-9:._-]+$'),
  actor_role                  text check (actor_role in ('superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario', 'system')),
  sync_status                 text not null check (sync_status in ('synced', 'pending', 'error')),
  unique (company_id, id),
  check ((actor_membership_id is null) <> (actor_system is null)),
  foreign key (company_id, route_id)                 references adex.routes(company_id, id),
  foreign key (company_id, from_admin_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, to_admin_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, actor_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, ledger_entry_id)          references adex.capital_ledger(company_id, id) deferrable initially deferred
);
alter table adex.capital_ledger
  add foreign key (company_id, related_event_id) references adex.route_capital_controller_events(company_id, id) deferrable initially deferred;

-- ---------- Caja socios (D1 ABIERTA: sin control de saldo) ----------
create table adex.partner_cash_movements (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  partner_membership_id       adex.eid not null,
  type                        text not null check (type in ('ingreso', 'salida')),
  category                    text not null check (category in ('ingreso', 'reembolso', 'inversion', 'retiro', 'envio_exterior', 'transferencia', 'otro')),
  amount_minor                bigint not null check (amount_minor <> 0),
  description                 text,
  related_transfer_id         adex.eid,
  movement_date               date not null,
  created_at                  timestamptz not null,
  created_by_membership_id    adex.eid,
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check ((amount_minor < 0) = (reverses_id is not null)),
  foreign key (company_id, partner_membership_id)     references adex.memberships(company_id, id),
  foreign key (company_id, related_transfer_id)       references adex.transfers(company_id, id),
  foreign key (company_id, created_by_membership_id)  references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)               references adex.partner_cash_movements(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)               references adex.partner_cash_movements(company_id, id) deferrable initially deferred
);

-- ---------- Custodia de Base física (v15) ----------
create table adex.cash_custody_movements (
  id                          adex.eid primary key,
  company_id                  adex.eid not null references adex.companies(id),
  route_id                    adex.eid not null,
  kind                        text not null check (kind in ('BASE_ASSIGNMENT', 'BASE_RETURN', 'PERSON_TO_PERSON')),
  amount_minor                bigint not null check (amount_minor <> 0),
  from_membership_id          adex.eid,          -- NULL = caja no asignada de la ruta
  to_membership_id            adex.eid,
  origin                      text not null check (origin in ('route-cash', 'transfer')),
  related_transfer_id         adex.eid,
  reason                      text not null,
  movement_date               date not null,
  created_at                  timestamptz not null,   -- frontera del cuadre
  created_by_membership_id    adex.eid not null,
  reversal_id                 adex.eid,
  reversed_at                 timestamptz,
  reversed_by_membership_id   adex.eid,
  reversal_reason             text,
  reverses_id                 adex.eid,
  unique (company_id, id),
  unique (company_id, reverses_id),
  check ((amount_minor < 0) = (reverses_id is not null)),
  -- Forma de cada movimiento: nunca se infiere la persona.
  check (kind <> 'BASE_ASSIGNMENT'  or (from_membership_id is null and to_membership_id is not null)),
  check (kind <> 'BASE_RETURN'      or (from_membership_id is not null and to_membership_id is null)),
  check (kind <> 'PERSON_TO_PERSON' or (from_membership_id is not null and to_membership_id is not null
                                         and from_membership_id <> to_membership_id)),
  check ((origin = 'transfer') = (related_transfer_id is not null)),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, from_membership_id)        references adex.memberships(company_id, id),
  foreign key (company_id, to_membership_id)          references adex.memberships(company_id, id),
  foreign key (company_id, related_transfer_id)       references adex.transfers(company_id, id),
  foreign key (company_id, created_by_membership_id)  references adex.memberships(company_id, id),
  foreign key (company_id, reversed_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reversal_id)               references adex.cash_custody_movements(company_id, id) deferrable initially deferred,
  foreign key (company_id, reverses_id)               references adex.cash_custody_movements(company_id, id) deferrable initially deferred
);
create index cash_custody_route_created on adex.cash_custody_movements (company_id, route_id, created_at);

-- ---------- Cuadre por trabajador (v14) ----------
create table adex.cash_settlements (
  id                              adex.eid primary key,
  company_id                      adex.eid not null references adex.companies(id),
  route_id                        adex.eid not null,
  worker_membership_id            adex.eid not null,
  period_from                     timestamptz not null,   -- EXCLUSIVO
  period_to                       timestamptz not null,   -- INCLUSIVO
  period_from_origin              text not null check (period_from_origin in ('ultimo-cierre', 'inicio-modelo')),
  previous_settlement_id          adex.eid,
  carried_over_minor              bigint not null check (carried_over_minor >= 0),
  base_received_minor             bigint,
  base_returned_minor             bigint,
  collected_minor                 bigint not null,
  disbursed_minor                 bigint not null,
  expenses_minor                  bigint not null,
  expected_minor                  bigint not null,
  delivered_minor                 bigint not null,
  difference_minor                bigint not null,
  shortage_minor                  bigint not null,
  surplus_minor                   bigint not null,
  reason                          text,
  status                          text not null check (status in ('cerrada', 'reabierta')),
  version                         integer not null check (version >= 1),
  superseded_by                   adex.eid,
  created_at                      timestamptz not null,
  closed_at                       timestamptz not null,
  closed_by_membership_id         adex.eid not null,
  reopened_at                     timestamptz,
  reopened_by_membership_id       adex.eid,
  reopen_reason                   text,
  capital_controller_at_close_id  adex.eid,
  unique (company_id, id),
  check (period_from < period_to),
  -- diferencia = entregado − esperado; arrastre = máx(0, −diferencia); sobrante no es crédito.
  check (difference_minor = delivered_minor - expected_minor),
  check (shortage_minor = greatest(0, -difference_minor)),
  check (surplus_minor = greatest(0, difference_minor)),
  check (difference_minor = 0 or length(btrim(coalesce(reason, ''))) > 0),
  check ((status = 'reabierta') = (reopened_at is not null)),
  foreign key (company_id, route_id)                       references adex.routes(company_id, id),
  foreign key (company_id, worker_membership_id)           references adex.memberships(company_id, id),
  foreign key (company_id, closed_by_membership_id)        references adex.memberships(company_id, id),
  foreign key (company_id, reopened_by_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, capital_controller_at_close_id) references adex.memberships(company_id, id),
  foreign key (company_id, previous_settlement_id)         references adex.cash_settlements(company_id, id) deferrable initially deferred,
  foreign key (company_id, superseded_by)                  references adex.cash_settlements(company_id, id) deferrable initially deferred
);
create index cash_settlements_cycle on adex.cash_settlements (company_id, route_id, worker_membership_id, period_to);

-- ---------- Liquidación y cierre semanal de la ruta ----------
create table adex.weekly_settlements (
  id                              adex.eid primary key,
  company_id                      adex.eid not null references adex.companies(id),
  route_id                        adex.eid not null,
  week_start                      date not null,
  week_end                        date not null,
  opening_balance_minor           bigint not null,
  capital_in_minor                bigint not null,
  collections_minor               bigint not null,
  loans_disbursed_minor           bigint not null,
  expenses_minor                  bigint not null,
  transfers_in_minor              bigint not null,
  transfers_out_minor             bigint not null,
  withdrawals_minor               bigint not null,
  closing_balance_minor           bigint not null,
  created_at                      timestamptz not null,
  status                          text check (status in ('abierta', 'cerrada', 'reabierta')),   -- NULL = cerrada (legado)
  created_by_membership_id        adex.eid,
  closed_at                       timestamptz,
  closed_by_membership_id         adex.eid,
  reopened_at                     timestamptz,
  reopened_by_membership_id       adex.eid,
  reopen_reason                   text,
  version                         integer check (version >= 1),
  superseded_by                   adex.eid,
  office_id_at_close              adex.eid,     -- foto histórica: sin FK a propósito (la Oficina puede desaparecer)
  office_name_at_close            text,
  office_code_at_close            text,
  capital_controller_at_close_id  adex.eid,
  unique (company_id, id),
  check (week_start <= week_end),
  check (status is distinct from 'reabierta' or length(btrim(coalesce(reopen_reason, ''))) > 0),
  foreign key (company_id, route_id)                       references adex.routes(company_id, id),
  foreign key (company_id, created_by_membership_id)       references adex.memberships(company_id, id),
  foreign key (company_id, closed_by_membership_id)        references adex.memberships(company_id, id),
  foreign key (company_id, reopened_by_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, capital_controller_at_close_id) references adex.memberships(company_id, id),
  foreign key (company_id, superseded_by)                  references adex.weekly_settlements(company_id, id) deferrable initially deferred
);
create index weekly_settlements_route_week on adex.weekly_settlements (company_id, route_id, week_start);

-- ---------- Auditoría ----------
-- Incluye la auditoría local importada (sin `txid`) y la del servidor, que se
-- escribe en la MISMA transacción que el comando (`txid`) con identidad y rol.
create table adex.audit_log (
  id                    adex.eid primary key,
  company_id            adex.eid not null references adex.companies(id),
  actor_membership_id   adex.eid,
  actor_system          text check (actor_system ~ '^system:[a-z0-9:._-]+$'),
  actor_identity_id     uuid references adex.identities(id),      -- NULL en la auditoría local importada
  actor_role            text check (actor_role in ('superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario')),
  route_id              adex.eid,
  action                text not null check (action ~ '^[A-Z][A-Z0-9_]*$'),
  entity_type           text not null,
  entity_id             text not null,
  description           text not null,
  before_data           jsonb,
  after_data            jsonb,
  reason                text,
  metadata              jsonb,
  operation_id          uuid,
  txid                  bigint,
  created_at            timestamptz not null,
  unique (company_id, id),
  check ((actor_membership_id is null) <> (actor_system is null)),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, route_id)            references adex.routes(company_id, id)
);
create index audit_log_company_created on adex.audit_log (company_id, created_at);
create index audit_log_entity on adex.audit_log (company_id, entity_type, entity_id);

-- ---------- Idempotencia de comandos (P3) ----------
-- Una fila por (empresa, operationId). `request_hash` fija los parámetros: reutilizar
-- el identificador con otros parámetros se rechaza (patrón validado en 0A/0A.1).
create table adex.operations (
  company_id    adex.eid not null references adex.companies(id),
  operation_id  uuid not null,
  kind          text not null check (kind ~ '^[a-z][a-z0-9_.]*$'),
  request_hash  text not null,
  membership_id adex.eid not null,
  outcome       text not null check (outcome in ('pending', 'approved', 'rejected')),
  http_status   smallint,
  result        jsonb,
  created_at    timestamptz not null default now(),
  primary key (company_id, operation_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

-- ============================================================
-- Inmutabilidad (D7, D28; INVARIANTES §3)
-- ============================================================

create function adex.reject_mutation() returns trigger
  language plpgsql
  as $$ begin
    raise exception 'adex: % on % is not allowed (financial history is immutable)', tg_op, tg_table_name
      using errcode = '42501';
  end $$;

-- Movimiento anulable: solo los campos de reversión, y solo una vez (NULL → valor).
create function adex.guard_reversible_movement() returns trigger
  language plpgsql
  as $$
  declare
    rev_keys text[] := array['reversal_id', 'reversed_at', 'reversed_by_membership_id', 'reversal_reason'];
  begin
    if (to_jsonb(new) - rev_keys) is distinct from (to_jsonb(old) - rev_keys) then
      raise exception 'adex: % row % is immutable except its reversal link', tg_table_name, old.id using errcode = '42501';
    end if;
    if old.reversal_id is not null and (to_jsonb(new) -> 'reversal_id', to_jsonb(new) -> 'reversed_at', to_jsonb(new) -> 'reversed_by_membership_id', to_jsonb(new) -> 'reversal_reason')
         is distinct from (to_jsonb(old) -> 'reversal_id', to_jsonb(old) -> 'reversed_at', to_jsonb(old) -> 'reversed_by_membership_id', to_jsonb(old) -> 'reversal_reason') then
      raise exception 'adex: % row % is already reversed', tg_table_name, old.id using errcode = '42501';
    end if;
    if new.reversal_id is not null and old.reverses_id is not null then
      raise exception 'adex: a reversal entry (% %) cannot be reversed', tg_table_name, old.id using errcode = '42501';
    end if;
    return new;
  end $$;

-- Monotonía de pagos (`paymentState.assertPaymentTransitionAllowed`, ajustes 2026-10-02 §8).
create function adex.guard_payment_transition() returns trigger
  language plpgsql
  as $$ begin
    if old.state in ('reversed', 'reversal') and new.state is distinct from old.state then
      raise exception 'adex: payment % is % and cannot change state', old.id, old.state using errcode = '42501';
    end if;
    if old.reverses_payment_id is not null and new.reverses_payment_id is distinct from old.reverses_payment_id then
      raise exception 'adex: reversal % cannot change its original payment', old.id using errcode = '42501';
    end if;
    if old.reversal_payment_id is not null and new.reversal_payment_id is distinct from old.reversal_payment_id then
      raise exception 'adex: payment % already has its reversal linked', old.id using errcode = '42501';
    end if;
    -- Importe, venta, ruta, fecha, responsable y alta son hechos: no se reescriben.
    if (new.amount_minor, new.sale_id, new.route_id, new.client_id, new.payment_date, new.collector_membership_id, new.payment_type, new.created_at)
         is distinct from
       (old.amount_minor, old.sale_id, old.route_id, old.client_id, old.payment_date, old.collector_membership_id, old.payment_type, old.created_at) then
      raise exception 'adex: payment % facts are immutable (use a reversal entry)', old.id using errcode = '42501';
    end if;
    return new;
  end $$;

-- Cierres (D7): un cierre nunca se sobrescribe. Solo se marca `reabierta` (con
-- motivo, quién y cuándo) y se enlaza con la versión que lo sustituye.
create function adex.guard_closure() returns trigger
  language plpgsql
  as $$
  declare
    mutable_keys text[] := array['status', 'reopened_at', 'reopened_by_membership_id', 'reopen_reason', 'superseded_by'];
    old_status text := coalesce(old.status, 'cerrada');
  begin
    if (to_jsonb(new) - mutable_keys) is distinct from (to_jsonb(old) - mutable_keys) then
      raise exception 'adex: closure % % is immutable', tg_table_name, old.id using errcode = '42501';
    end if;
    if old_status = 'reabierta' and (to_jsonb(new) - 'superseded_by') is distinct from (to_jsonb(old) - 'superseded_by') then
      raise exception 'adex: reopened closure % is final', old.id using errcode = '42501';
    end if;
    if old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by then
      raise exception 'adex: closure % is already superseded', old.id using errcode = '42501';
    end if;
    if new.status is distinct from old.status
       and not (old_status = 'abierta' and new.status = 'cerrada')
       and not (old_status = 'cerrada' and new.status = 'reabierta') then
      raise exception 'adex: closure % cannot go from % to %', old.id, old_status, new.status using errcode = '42501';
    end if;
    return new;
  end $$;

-- Sin borrado físico de nada financiero ni histórico.
do $$
declare t text;
begin
  foreach t in array array['sales', 'installments', 'payments', 'payment_adjustment_requests', 'no_payment_visits',
                           'expenses', 'capital_movements', 'transfers', 'withdrawals', 'capital_ledger',
                           'route_capital_controller_events', 'partner_cash_movements', 'cash_custody_movements',
                           'cash_settlements', 'weekly_settlements', 'audit_log', 'operations', 'sale_requests']
  loop
    execute format('create trigger %I before delete on adex.%I for each statement execute function adex.reject_mutation()',
                   t || '_no_delete', t);
    execute format('create trigger %I before truncate on adex.%I for each statement execute function adex.reject_mutation()',
                   t || '_no_truncate', t);
  end loop;
  foreach t in array array['expenses', 'capital_movements', 'transfers', 'withdrawals', 'capital_ledger',
                           'partner_cash_movements', 'cash_custody_movements']
  loop
    execute format('create trigger %I before update on adex.%I for each row execute function adex.guard_reversible_movement()',
                   t || '_reversible', t);
  end loop;
end $$;

create trigger route_capital_controller_events_append_only before update on adex.route_capital_controller_events
  for each row execute function adex.reject_mutation();
create trigger audit_log_append_only before update on adex.audit_log
  for each row execute function adex.reject_mutation();
create trigger payments_transition before update on adex.payments
  for each row execute function adex.guard_payment_transition();
create trigger cash_settlements_closure before update on adex.cash_settlements
  for each row execute function adex.guard_closure();
create trigger weekly_settlements_closure before update on adex.weekly_settlements
  for each row execute function adex.guard_closure();
