// Candado de `npm run test:auth-real` (pendiente 3.8, 2026-11-03).
//
// Estas pruebas crean empresas y personas sintéticas (`stg-*`, `@example.test`) en el
// proyecto Supabase «ADEX-Staging», que desde la Ronda 54 aloja la empresa REAL BlueLine.
// Además describen reglas ya sustituidas: el SuperAdmin escritor (cambió en la Ronda 67, que
// lo dejó de solo lectura) y las anulaciones por cualquier responsable (cambió en la Ronda 79,
// RB-D11: solo el Administrador). Las reglas vigentes las cubre `npm run test:db` sobre un
// PostgreSQL local y aislado.
//
// Por decisión del propietario no se ejecutan contra ADEX Online. Quedan como referencia
// histórica; ejecutarlas exige reescribirlas y una autorización expresa.
if (process.env['ADEX_AUTH_REAL_AUTORIZADO'] !== 'si') {
  console.error([
    'test:auth-real está bloqueado: escribe datos sintéticos en ADEX-Staging (donde vive BlueLine)',
    'y sus escenarios suponen reglas ya retiradas (SuperAdmin escritor, R67; anulaciones, R79).',
    'Las reglas vigentes se prueban con: npm run test:db',
  ].join('\n'));
  process.exitCode = 1;
}
