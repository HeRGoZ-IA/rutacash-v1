// Escrituras permitidas al rol de la API de empresa (`adex_api`), por tabla. Es el
// CONTRATO que verifica test/contracts/tenancy (TEN-003) contra los GRANT reales:
// cualquier privilegio nuevo exige actualizar esta lista en el mismo cambio.
//
//   Fase 0: ninguna (solo lectura).
//   Fase 1: identidad y membresías (ver 0005).
// Nunca DELETE ni TRUNCATE.
export const EXPECTED_API_WRITES: Record<string, string[]> = {};
