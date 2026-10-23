// El manifiesto del banco de contratos coincide con CLEAN: las 27 suites de
// `npm test` (26 históricas con 1.600 casos + capital centralizado C1/C2), y el
// analizador reconoce los cuatro formatos de total.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUITES, TOTAL_CASES, parseSuiteTotals } from '../../src/contracts/suiteManifest.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('banco de contratos · manifiesto', () => {
  // R74: + displayname (36 casos, presentación de nombres).
  test('BENCH-001 · 28 suites, 1.673 casos (1.600 verificados en 0A.1 §19 + 37 de capital centralizado + 36 de nombres)', () => {
    assert.equal(SUITES.length, 28);
    assert.equal(TOTAL_CASES, 1673);
    assert.equal(TOTAL_CASES - SUITES.find((x) => x.suite === 'centralcapital')!.cases - SUITES.find((x) => x.suite === 'displayname')!.cases, 1600);
  });

  test('BENCH-002 · el manifiesto lista exactamente los scripts que encadena `npm test` de CLEAN', () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const chained = [...pkg.scripts['test']!.matchAll(/npm run (test:\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...SUITES.map((s) => s.script)].sort(), [...chained].sort());
  });

  test('BENCH-003 · Fase 2: solo `permissions` se declara contra el servidor, con su prueba; el resto sigue local y justificado', () => {
    assert.deepEqual(SUITES.filter((s) => s.target === 'server').map((s) => s.suite), ['permissions']);
    for (const s of SUITES) {
      assert.ok(s.serverPhase >= 2, `${s.suite} needs server commands from phase ≥ 2`);
      if (s.target === 'server') {
        assert.ok(s.serverPhase <= 2 && s.serverEvidence, s.suite);
        assert.ok(readFileSync(path.join(repo, 'saas', s.serverEvidence!), 'utf8').includes('can('), `${s.suite}: evidence compares with can()`);
      } else if (s.serverPhase <= 2) {
        assert.ok((s.note ?? '').length > 80, `${s.suite}: a phase-2 suite still local must justify it`);
      }
    }
  });

  test('BENCH-004 · el analizador reconoce los cuatro formatos de total y los fallos', () => {
    const sample = [
      '> rutacash@1.0.0 test:permissions', 'PRUEBA DE PERMISOS: 559 OK, 0 FALLIDAS',
      '> rutacash@1.0.0 test:financial', '  TOTAL: 180 casos   179 PASS   1 FAIL',
      '> rutacash@1.0.0 test:capitalcontrol', '  47/47 casos OK',
      '> rutacash@1.0.0 test:disbursement', '13/13 PASS · 0 FAIL',
    ].join('\n');
    const t = parseSuiteTotals(sample);
    assert.deepEqual(Object.fromEntries(t), {
      'test:permissions': { cases: 559, failed: 0 },
      'test:financial': { cases: 180, failed: 1 },
      'test:capitalcontrol': { cases: 47, failed: 0 },
      'test:disbursement': { cases: 13, failed: 0 },
    });
  });
});
