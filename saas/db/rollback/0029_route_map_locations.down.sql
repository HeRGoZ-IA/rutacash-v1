-- REVERSIÓN de 0029 (manual, como adex_owner, en una transacción). Borra las ubicaciones de referencia
-- de clientes y las del dispositivo al vender: exportarlas antes si hay que conservarlas. Ventas,
-- solicitudes, abonos y saldos NO se tocan (viven en sus tablas). La lectura de `payment_locations`
-- vuelve a quedar cerrada (0022). `ctx_can` conserva las dos capacidades nuevas: sin tablas no habilitan nada.
-- Después: delete from adex_meta.schema_migrations where version = '0029'.

begin;

set local role adex_owner;

drop policy payment_locations_read on adex.payment_locations;
revoke select on adex.payment_locations from adex_api;
drop table adex.client_locations;
drop table adex.sale_locations;
drop function adex.client_location_guard();
drop function adex.sale_location_guard();

commit;
