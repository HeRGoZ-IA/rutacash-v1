// El manifiesto del banco de contratos coincide con CLEAN: las 26 suites de
// `npm test`, 1.600 casos, y el analizador reconoce los cuatro formatos de total.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUITES, TOTAL_CASES, parseSuiteTotals } from '../../src/contracts/suiteManifest.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('banco de contratos · manifiesto', () => {
  test('BENCH-001 · 26 suites, 1.600 casos (cifra verificada en 0A.1 §19)', () => {
    assert.equal(SUITES.length, 26);
    assert.equal(TOTAL_CASES, 1600);
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
