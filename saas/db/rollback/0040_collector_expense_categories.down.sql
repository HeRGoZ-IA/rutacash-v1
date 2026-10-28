-- Reversión de 0040: quita la casilla «Para Cobradores», la eliminación con historia y el aviso de capturas.
-- Se ejecuta como administrador SOLO si hubiera que deshacer 0040 (ver procedimiento de R73 §7.5).
-- Los tipos eliminados con historia vuelven a la lista como INACTIVOS (sus gastos no cambian). Si dos
-- tipos no eliminados comparten nombre con uno eliminado, el índice único original falla: renombrar antes.
-- Después: delete from adex_meta.schema_migrations where version = '0040'.
begin;
drop policy if exists offline_captures_admin_read on adex.offline_captures;
revoke select on adex.offline_captures from adex_api;
alter table adex.offline_captures drop column category_outside_list;

drop trigger if exists expense_categories_deleted_frozen on adex.expense_categories;
drop function if exists adex.expense_category_deleted_frozen();
drop trigger if exists expense_categories_collector_default on adex.expense_categories;
drop function if exists adex.expense_category_collector_default();

drop index adex.expense_categories_company_name_key;
alter table adex.expense_categories drop constraint expense_categories_deleted_inactive;
alter table adex.expense_categories drop column deleted_at;
alter table adex.expense_categories drop column for_collectors;
create unique index expense_categories_company_name_key on adex.expense_categories (company_id, lower(btrim(name)));
drop function if exists adex.default_collector_category(text);
commit;
