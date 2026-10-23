// ============================================================
// Banco de contratos (plan §5.1): las 27 suites del motor local como contrato del
// servidor. Cada suite indica la FASE en la que debe pasar contra el servidor
// (columna «Puerta» del plan §2) y la familia de comandos que la sustituirá.
//
// Estado honesto por suite:
//   'local'  → hoy se ejecuta contra el motor local (Dexie). Es la línea base.
//   'server' → además de su línea base local, su contrato se verifica contra el
//              servidor real (API + PostgreSQL) en `serverEvidence`.
// `scripts/run-contract-bench.ts` ejecuta las 27 y compara los casos con este
// manifiesto: una suite que pierda casos o falle rompe el banco.
// ============================================================

export type Target = 'local' | 'server';

export interface SuiteContract {
  suite: string;
  /** Script de `package.json` de CLEAN. */
  script: string;
  cases: number;
  /** Fase del plan en cuya puerta debe pasar CONTRA EL SERVIDOR. */
  serverPhase: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  commands: string;
  target: Target;
  /** Prueba del paquete SaaS que verifica el contrato contra el servidor (solo `server`). */
  serverEvidence?: string;
  note?: string;
}

export const SUITES: readonly SuiteContract[] = [
  { suite: 'permissions', script: 'test:permissions', cases: 559, serverPhase: 2, commands: 'autorización de todos los comandos', target: 'server',
    serverEvidence: 'test/integration/authz-matrix.test.ts',
    note: 'Puerta de la Fase 2: cada comando de estructura y catálogo × 6 roles × ruta dentro/fuera de alcance, respuesta HTTP real = `can()` de src/lib/permissions.ts (importado, sin copiar). La matriz pura sigue en la suite local' },
  { suite: 'financial', script: 'test:financial', cases: 180, serverPhase: 4, commands: 'pagos y parcelas', target: 'local' },
  { suite: 'bootstrap', script: 'test:bootstrap', cases: 159, serverPhase: 2, commands: 'alta de empresa y estructura inicial', target: 'local',
    note: 'Fuera de la puerta del plan. Equivalentes del servidor: alta de empresa y primer SuperAdmin por el Owner (OWN-004), categorías predeterminadas (CAT-001), estructura inicial (STR-*). La instalación local con Owner y contraseñas propias no existe en el servidor (DS-03)' },
  { suite: 'platform', script: 'test:platform', cases: 64, serverPhase: 2, commands: 'plano de control Owner', target: 'local',
    note: 'Fuera de la puerta del plan. Plano Owner separado (DS-17) desde la Fase 1: OWN-001…008; `billableRouteCount` sobre las rutas de la API (STR-023)' },
  { suite: 'settlements', script: 'test:settlements', cases: 40, serverPhase: 6, commands: 'liquidación y cierre semanal', target: 'local' },
  { suite: 'migrations', script: 'test:migrations', cases: 62, serverPhase: 7, commands: 'exportación y diagnóstico de bases Dexie', target: 'local' },
  { suite: 'workercash', script: 'test:workercash', cases: 123, serverPhase: 6, commands: 'cuadre por trabajador', target: 'local' },
  { suite: 'basecash', script: 'test:basecash', cases: 45, serverPhase: 3, commands: 'Base y custodia', target: 'local' },
  { suite: 'interestrate', script: 'test:interestrate', cases: 8, serverPhase: 4, commands: 'solicitudes de venta (tasas)', target: 'local' },
  { suite: 'activecredit', script: 'test:activecredit', cases: 10, serverPhase: 4, commands: 'crédito activo y solicitudes', target: 'local' },
  { suite: 'financialreversal', script: 'test:financialreversal', cases: 15, serverPhase: 5, commands: 'anulación de capital, retiro y transferencia', target: 'local' },
  { suite: 'routebase', script: 'test:routebase', cases: 21, serverPhase: 3, commands: 'Base de la ruta y conciliación', target: 'local' },
  { suite: 'supervisorbase', script: 'test:supervisorbase', cases: 20, serverPhase: 3, commands: 'custodia del Supervisor', target: 'local' },
  { suite: 'workertransfer', script: 'test:workertransfer', cases: 22, serverPhase: 3, commands: 'traspaso entre trabajadores', target: 'local' },
  { suite: 'paymentreversal', script: 'test:paymentreversal', cases: 31, serverPhase: 5, commands: 'corrección y anulación de pagos', target: 'local' },
  { suite: 'paymentsync', script: 'test:paymentsync', cases: 31, serverPhase: 4, commands: 'pagos con operationId y estados', target: 'local' },
  { suite: 'expenseclassification', script: 'test:expenseclassification', cases: 31, serverPhase: 5, commands: 'gastos clasificados', target: 'local' },
  { suite: 'capitalcontrol', script: 'test:capitalcontrol', cases: 47, serverPhase: 3, commands: 'capital por Administrador', target: 'local' },
  { suite: 'expensecash', script: 'test:expensecash', cases: 14, serverPhase: 5, commands: 'gastos del trabajador', target: 'local' },
  { suite: 'adminexpense', script: 'test:adminexpense', cases: 19, serverPhase: 5, commands: 'gastos de bolsa', target: 'local' },
  { suite: 'adminpool', script: 'test:adminpool', cases: 8, serverPhase: 3, commands: 'bolsas de Administrador', target: 'local' },
  { suite: 'transferops', script: 'test:transferops', cases: 10, serverPhase: 3, commands: 'transferencias', target: 'local' },
  { suite: 'movementhistory', script: 'test:movementhistory', cases: 10, serverPhase: 3, commands: 'historial y Caja socios', target: 'local' },
  { suite: 'disbursement', script: 'test:disbursement', cases: 13, serverPhase: 4, commands: 'desembolso único (D24–D26, D30)', target: 'local' },
  { suite: 'capitalcustody', script: 'test:capitalcustody', cases: 28, serverPhase: 4, commands: 'CAP/CASH/AUTH de desembolsos', target: 'local' },
  { suite: 'periodauthority', script: 'test:periodauthority', cases: 30, serverPhase: 6, commands: 'D7, D29, cierres y autoridad de caja', target: 'local' },
  // C1/C2 (2026-10-15): capital centralizado en el Administrador. Contrato del modelo que la Fase 3 implementa desde cero.
  { suite: 'centralcapital', script: 'test:centralcapital', cases: 37, serverPhase: 3, commands: 'capital centralizado: entrega, devolución, cuadre a la bolsa, aportes de socio, transición', target: 'local' },
  { suite: 'displayname', script: 'test:displayname', cases: 36, serverPhase: 7, commands: 'presentación de nombres (solo la vista, R74 bloque C)', target: 'local',
    note: 'Función pura de presentación sin comandos de servidor: formatea nombres escritos en mayúsculas al mostrarlos; nunca cambia el valor guardado. No tiene equivalente en el servidor' },
];

export const TOTAL_CASES = SUITES.reduce((n, s) => n + s.cases, 0);

/**
 * Extrae «suite → (casos, fallos)» de la salida de `npm test` de CLEAN. Las suites
 * imprimen su total con cuatro formatos distintos; un formato desconocido no cuenta.
 */
export function parseSuiteTotals(output: string): Map<string, { cases: number; failed: number }> {
  const out = new Map<string, { cases: number; failed: number }>();
  const sections = output.split(/^> rutacash@[\d.]+ (test:\w+)$/m);
  for (let i = 1; i < sections.length; i += 2) {
    const script = sections[i]!;
    const body = sections[i + 1] ?? '';
    let m: RegExpMatchArray | null;
    if ((m = body.match(/PRUEBA DE PERMISOS: (\d+) OK, (\d+) FALLIDAS/))) out.set(script, { cases: +m[1]! + +m[2]!, failed: +m[2]! });
    else if ((m = body.match(/TOTAL: (\d+) casos\s+(\d+) PASS\s+(\d+) FAIL/))) out.set(script, { cases: +m[1]!, failed: +m[3]! });
    else if ((m = body.match(/(\d+)\/(\d+) casos OK/))) out.set(script, { cases: +m[2]!, failed: +m[2]! - +m[1]! });
    else if ((m = body.match(/^(\d+)\/(\d+) PASS · (\d+) FAIL/m))) out.set(script, { cases: +m[2]!, failed: +m[3]! });
  }
  return out;
}
