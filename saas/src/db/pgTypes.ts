// Tipos de `pg`: las fechas contables (`date`, OID 1082) se leen como texto
// `yyyy-MM-dd`. Convertirlas a Date las desplazaría a la zona horaria del proceso.
// `bigint` y `numeric` ya llegan como texto (sin pérdida). Importar una vez por proceso.
import pg from 'pg';

pg.types.setTypeParser(1082, (v: string) => v);

export default pg;
