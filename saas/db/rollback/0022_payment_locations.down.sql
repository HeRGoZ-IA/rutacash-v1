-- REVERSIÓN de 0022 (manual, como adex_owner, en una transacción). Borra las ubicaciones
-- registradas: exportarlas antes si hay que conservarlas. Los abonos NO se tocan (viven
-- en adex.payments). Después: delete from adex_meta.schema_migrations where version = '0022'.

begin;

set local role adex_owner;

drop table adex.payment_locations;
drop function adex.payment_location_guard();

commit;
