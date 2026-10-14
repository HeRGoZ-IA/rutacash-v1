// Banco de contratos: ejecuta `npm test` de CLEAN (sin modificar nada) y contrasta
// cada suite con `src/contracts/suiteManifest.ts`: mismos casos, cero fallos.
// Imprime el destino de cada suite (local hoy; servidor en su fase). No toca CLEAN.
//
//   node scripts/run-contract-bench.ts            → ejecuta las 26 suites
//   node scripts/run-contract-bench.ts <log>      → solo contrasta un log ya generado

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SUITES, TOTAL_CASES, parseSuiteTotals } from '../src/contracts/suiteManifest.ts';
import { repoRoot, tmpRoot } from './local-cluster.ts';

const given = process.argv[2];
let output: string;
if (given) {
  output = readFileSync(given, 'utf8');
} else {
  const r = spawnSync('npm', ['test'], { cwd: repoRoot, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  output = `${r.stdout}\n${r.stderr}`;
  mkdirSync(path.join(tmpRoot, 'evidence'), { recursive: true });
  const log = path.join(tmpRoot, 'evidence', `contract-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  writeFileSync(log, output);
  console.log(`# salida completa: ${log} · npm test exit ${r.status}`);
}

const totals = parseSuiteTotals(output);
let ok = true;
let sum = 0;
console.log('suite                  casos  esperado  fallos  destino hoy  servidor en');
for (const s of SUITES) {
  const t = totals.get(s.script);
  const line = `${s.suite.padEnd(22)} ${String(t?.cases ?? '—').padStart(5)}  ${String(s.cases).padStart(8)}  ${String(t?.failed ?? '—').padStart(6)}  ${s.target.padEnd(11)}  Fase ${s.serverPhase}`;
  console.log(line);
  if (!t || t.cases !== s.cases || t.failed !== 0) ok = false;
  sum += t?.cases ?? 0;
}
console.log(`TOTAL ${sum} / ${TOTAL_CASES} · ${ok ? 'BANCO EN VERDE' : 'BANCO EN ROJO'}`);
process.exit(ok && sum === TOTAL_CASES ? 0 : 1);
