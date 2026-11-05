-- 0047 · Lista de tipos de gasto del socio (pendiente 3.29; decisiones del propietario 2026-11-05).
--   · Base inicial de 50 tipos (docs/GASTOS_BASE_INICIAL_SOCIO_2026-11-05.md); 11 nacen «Para Cobradores».
--   · Empresas NUEVAS: `adex_control.create_company` crea los 50 (antes: Transporte, Alimentación, Papelería, Combustible,
--     Comunicación, Mantenimiento y Otros). La Empresa Demo (`adex_demo.provision_company`, retirada) no cambia.
--   · `adex.default_collector_category`: nacen marcados los 11 tipos del socio. Transporte, Alimentación y Combustible
--     siguen marcándose por nombre si un Administrador los crea (como en 0040); cada empresa cambia la casilla cuando quiera.
--   · Empresas EXISTENTES (BlueLine), sin duplicar por nombre (sin mayúsculas ni tildes) y sin borrar ningún tipo ni gasto:
--       1. «Combustible» pasa a llamarse «Gasolina» (es el mismo tipo: sus gastos lo conservan y se ven como «Gasolina»).
--       2. Se DESACTIVAN Alimentación, Transporte, Comunicación, Mantenimiento y Papelería (no están en la lista; sus
--          gastos, si los hay, conservan su tipo; el Administrador puede reactivarlos).
--       3. «Otros» queda «Para Cobradores», como en la lista del socio.
--       4. Se añaden los tipos de la lista que falten, con la casilla de la lista.
--     No se tocan la naturaleza (`nature`) ni el icono de ningún tipo.

-- Clave de comparación: sin mayúsculas, sin espacios en los extremos y sin tildes (portugués y español).
create function adex.expense_category_key(p_name text) returns text
  language sql immutable set search_path = pg_catalog
  as $$ select lower(btrim(translate(p_name, 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
                                               'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'))) $$;
revoke all on function adex.expense_category_key(text) from public;
grant execute on function adex.expense_category_key(text) to adex_api;

-- Lista del socio (nombre y casilla), en el orden de su documento.
create function adex.partner_expense_categories() returns table (name text, for_collectors boolean)
  language sql immutable set search_path = pg_catalog
  as $$ select n, c from (values
    ('Gasolina', true), ('Aceite', true), ('Despinchada moto', true), ('Mantenimiento moto', true), ('Recarga celular', true),
    ('Arriendo funcionario', true), ('Seguro de moto', true), ('Impuesto CNPJ', true), ('Pago cadena', true),
    ('Medicamentos', true), ('Otros', true),
    ('Arriendo administrativo', false), ('Seguro de carro', false), ('Honorarios contador', false), ('Pago abogado', false),
    ('Pago PM / PC', false), ('Arreglo celular', false), ('Compra celular', false), ('SIM card celular', false),
    ('Artículos hogar funcionarios', false), ('Préstamos funcionarios', false), ('Comisión', false), ('Sueldo revisador', false),
    ('Sueldo panfleteador(a)', false), ('Sueldo secretario(a)', false), ('Dotación funcionarios', false), ('Compra de moto', false),
    ('Vistoria', false), ('IPVA y licenciamiento', false), ('Transferencia de moto', false), ('Cartório', false),
    ('Pago de multas', false), ('Declaración de renta', false), ('Descuadres', false), ('Fondo multas', false),
    ('Documentos funcionarios', false), ('Integración funcionarios', false), ('Interés', false), ('Lavada de moto', false),
    ('Prima funcionarios', false), ('Liquidación', false), ('Pago de sistema o aplicativo', false), ('Pago de administración', false),
    ('Panfletos', false), ('Sello panfletos', false), ('Pasaje aéreo', false), ('Reembolso', false),
    ('Seguro de repatriación', false), ('Viáticos', false), ('Uber', false)
  ) t (n, c) $$;
revoke all on function adex.partner_expense_categories() from public;
grant execute on function adex.partner_expense_categories() to adex_api;   -- lo usa default_collector_category (disparador)

-- Nombres que nacen marcados (toda vía de alta sin la casilla, ver el disparador de 0040).
create or replace function adex.default_collector_category(p_name text) returns boolean
  language sql immutable set search_path = pg_catalog, adex
  as $$ select adex.expense_category_key(p_name) in (
    select adex.expense_category_key(p.name) from adex.partner_expense_categories() p where p.for_collectors
    union all select unnest(array['transporte', 'alimentacion', 'combustible'])) $$;

-- ---------- Empresas nuevas ----------
create or replace function adex_control.create_company(
  p_id text, p_name text, p_email text, p_plan text, p_country_code text, p_country_label text,
  p_currency text, p_timezone text, p_tax_id text, p_contact text, p_billing_mode text, p_billing_rate numeric
) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, tax_id,
                                contact_name, created_at, updated_at)
    values (p_id, p_name, lower(btrim(p_email)), p_plan, 'prueba', p_country_code, p_country_label, p_currency, p_timezone, p_tax_id,
            p_contact, now(), now());
    insert into adex.expense_categories (id, company_id, name, active, for_collectors)
    select gen_random_uuid()::text, p_id, p.name, true, p.for_collectors from adex.partner_expense_categories() p;
    insert into adex_control.company_control (company_id, name, tax_id, contact_name, contact_email, created_at, status,
                                              route_count, billable_route_count, billing_mode, billing_rate, payment_status, updated_at)
    values (p_id, p_name, p_tax_id, p_contact, lower(btrim(p_email)), now(), 'trial', 0, 0, p_billing_mode, p_billing_rate, 'pending', now());
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_id, 'COMPANY_CREATED', now(), p_name);
  end $$;

-- ---------- Empresas existentes ----------
-- Función (sin permisos para nadie más que su dueño) para poder probar el ajuste sobre datos como los de BlueLine.
create function adex.apply_partner_expense_categories() returns void
  language plpgsql set search_path = pg_catalog, adex
  as $$ begin
    -- 1. Combustible → Gasolina (solo si la empresa no tiene ya un «Gasolina»).
    update adex.expense_categories k set name = 'Gasolina'
     where adex.expense_category_key(k.name) = 'combustible' and k.deleted_at is null
       and not exists (select 1 from adex.expense_categories g
                        where g.company_id = k.company_id and g.deleted_at is null and adex.expense_category_key(g.name) = 'gasolina')
       and k.company_id in (select c.id from adex.companies c where not c.is_demo);
    -- 2. Tipos de la lista anterior que no están en la nueva: desactivados (nunca borrados).
    update adex.expense_categories k set active = false
     where k.active and k.deleted_at is null
       and adex.expense_category_key(k.name) in ('alimentacion', 'transporte', 'comunicacion', 'mantenimiento', 'papeleria')
       and k.company_id in (select c.id from adex.companies c where not c.is_demo);
    -- 3. «Otros» para Cobradores.
    update adex.expense_categories k set for_collectors = true
     where not k.for_collectors and k.deleted_at is null and adex.expense_category_key(k.name) = 'otros'
       and k.company_id in (select c.id from adex.companies c where not c.is_demo);
    -- 4. Los que falten (un tipo existente con el mismo nombre, activo o no, se respeta tal como está).
    insert into adex.expense_categories (id, company_id, name, active, for_collectors)
    select gen_random_uuid()::text, c.id, p.name, true, p.for_collectors
      from adex.companies c cross join adex.partner_expense_categories() p
     where not c.is_demo
       and not exists (select 1 from adex.expense_categories k
                        where k.company_id = c.id and k.deleted_at is null
                          and adex.expense_category_key(k.name) = adex.expense_category_key(p.name));
  end $$;
revoke all on function adex.apply_partner_expense_categories() from public;

-- La migración corre como adex_owner (RLS forzada): permiso temporal SOLO para este ajuste (como 0040).
create policy owner_category_partner_list on adex.expense_categories for all to adex_owner using (true) with check (true);
select adex.apply_partner_expense_categories();
drop policy owner_category_partner_list on adex.expense_categories;
