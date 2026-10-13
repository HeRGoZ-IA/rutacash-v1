// Datos 100 % SINTÉTICOS. Ningún dato de CLEAN ni de usuarios reales.

import type pg from 'pg';

export const COMPANY_BR = '10000000-0000-4000-8000-000000000001';
export const COMPANY_CO = '10000000-0000-4000-8000-000000000002';

export const ROUTE_BR1 = '20000000-0000-4000-8000-000000000011';
export const ROUTE_BR2 = '20000000-0000-4000-8000-000000000012';
export const ROUTE_CO1 = '20000000-0000-4000-8000-000000000021';

export const ANA = '30000000-0000-4000-8000-000000000001';   // varias membresías en dos empresas
export const BRUNO = '30000000-0000-4000-8000-000000000002'; // admin CO
export const CARLA = '30000000-0000-4000-8000-000000000003'; // cobradora BR, ruta BR2
export const DARIO = '30000000-0000-4000-8000-000000000004'; // identidad sin membresías
export const EVA = '30000000-0000-4000-8000-000000000005';   // cobradora BR, ruta BR1
export const GHOST = '30000000-0000-4000-8000-0000000000ff'; // token válido, identidad no aprovisionada

export const M_ANA_BR_ADMIN = '40000000-0000-4000-8000-000000000101';
export const M_ANA_BR_COBRADOR = '40000000-0000-4000-8000-000000000102';
export const M_ANA_CO_SUPERVISOR = '40000000-0000-4000-8000-000000000103';
export const M_BRUNO_CO_ADMIN = '40000000-0000-4000-8000-000000000201';
export const M_CARLA_BR_COBRADOR = '40000000-0000-4000-8000-000000000301';
export const M_EVA_BR_COBRADOR = '40000000-0000-4000-8000-000000000501';

export const ACC_BR_COMPANY = '50000000-0000-4000-8000-000000000001';
export const ACC_BR_R1 = '50000000-0000-4000-8000-000000000011';
export const ACC_BR_R2 = '50000000-0000-4000-8000-000000000012';
export const ACC_CO_COMPANY = '50000000-0000-4000-8000-000000000021';
export const ACC_CO_R1 = '50000000-0000-4000-8000-000000000022';

export async function seed(superPool: pg.Pool): Promise<void> {
  await superPool.query(`
    insert into adex.companies (id, name, country_code, currency_code, timezone) values
      ('${COMPANY_BR}', 'Empresa Sintética Brasil',   'BR', 'BRL', 'America/Sao_Paulo'),
      ('${COMPANY_CO}', 'Empresa Sintética Colombia', 'CO', 'COP', 'America/Bogota');

    insert into adex.routes (id, company_id, name) values
      ('${ROUTE_BR1}', '${COMPANY_BR}', 'Rota BR-1'),
      ('${ROUTE_BR2}', '${COMPANY_BR}', 'Rota BR-2'),
      ('${ROUTE_CO1}', '${COMPANY_CO}', 'Ruta CO-1');

    insert into adex.identities (id, email) values
      ('${ANA}',   'ana@example.test'),
      ('${BRUNO}', 'bruno@example.test'),
      ('${CARLA}', 'carla@example.test'),
      ('${DARIO}', 'dario@example.test'),
      ('${EVA}',   'eva@example.test');

    insert into adex.memberships (id, identity_id, company_id, role, scope) values
      ('${M_ANA_BR_ADMIN}',      '${ANA}',   '${COMPANY_BR}', 'admin',      'company'),
      ('${M_ANA_BR_COBRADOR}',   '${ANA}',   '${COMPANY_BR}', 'cobrador',   'routes'),
      ('${M_ANA_CO_SUPERVISOR}', '${ANA}',   '${COMPANY_CO}', 'supervisor', 'company'),
      ('${M_BRUNO_CO_ADMIN}',    '${BRUNO}', '${COMPANY_CO}', 'admin',      'company'),
      ('${M_CARLA_BR_COBRADOR}', '${CARLA}', '${COMPANY_BR}', 'cobrador',   'routes'),
      ('${M_EVA_BR_COBRADOR}',   '${EVA}',   '${COMPANY_BR}', 'cobrador',   'routes');

    insert into adex.membership_routes (membership_id, company_id, route_id) values
      ('${M_ANA_BR_COBRADOR}',   '${COMPANY_BR}', '${ROUTE_BR1}'),
      ('${M_CARLA_BR_COBRADOR}', '${COMPANY_BR}', '${ROUTE_BR2}'),
      ('${M_EVA_BR_COBRADOR}',   '${COMPANY_BR}', '${ROUTE_BR1}');

    -- 5000.00 unidades ficticias = 500000 unidades menores.
    insert into adex.accounts (id, company_id, route_id, name, balance_minor) values
      ('${ACC_BR_COMPANY}', '${COMPANY_BR}', null,           'Caixa empresa BR', 500000),
      ('${ACC_BR_R1}',      '${COMPANY_BR}', '${ROUTE_BR1}', 'Caixa rota BR-1',  500000),
      ('${ACC_BR_R2}',      '${COMPANY_BR}', '${ROUTE_BR2}', 'Caixa rota BR-2',  100000),
      ('${ACC_CO_COMPANY}', '${COMPANY_CO}', null,           'Caja empresa CO',  500000),
      ('${ACC_CO_R1}',      '${COMPANY_CO}', '${ROUTE_CO1}', 'Caja ruta CO-1',   200000);
  `);
}
