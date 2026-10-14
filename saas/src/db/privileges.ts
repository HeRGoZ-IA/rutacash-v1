// Escrituras permitidas al rol de la API de empresa (`adex_api`), por tabla. Es el
// CONTRATO que verifica test/contracts/tenancy (TEN-003) contra los GRANT reales:
// cualquier privilegio nuevo exige actualizar esta lista en el mismo cambio.
//
//   Fase 0: ninguna (solo lectura).
//   Fase 1 (0005): identidad, membresías, rutas autorizadas, sesiones revocadas y
//   auditoría del servidor. DELETE solo en la asignación de rutas (no es historia
//   financiera; la baja queda auditada en la misma transacción).
// Nunca TRUNCATE. Nunca DELETE ni UPDATE sobre datos financieros.
export const EXPECTED_API_WRITES: Record<string, string[]> = {
  'adex.audit_log': ['INSERT'],
  'adex.identities': ['INSERT', 'UPDATE'],
  'adex.membership_routes': ['DELETE', 'INSERT'],
  'adex.memberships': ['INSERT', 'UPDATE'],
  'adex.revoked_sessions': ['INSERT'],
};
