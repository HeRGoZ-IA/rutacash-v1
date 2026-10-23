// ============================================================
// ADEX — presentación de nombres (intervención post-R73, bloque C)
//   npm run test:displayname
// Cualquier caso fallido → exit 1.
// ============================================================
import { formatBusinessName, formatClientName, formatPersonName } from '../src/lib/displayName'

let failed = 0
let passed = 0
function eq(id: string, actual: string, expected: string) {
  if (actual === expected) { passed++; return }
  failed++
  console.log(`✖ ${id}: «${actual}» ≠ «${expected}»`)
}

// Personas brasileñas y colombianas
eq('NAME-001', formatPersonName('JOAO FERREIRA DOS SANTOS'), 'Joao Ferreira dos Santos')
eq('NAME-002', formatPersonName('JOÃO DA SILVA E SOUZA'), 'João da Silva e Souza')
eq('NAME-003', formatPersonName('MARIA DAS GRAÇAS'), 'Maria das Graças')
eq('NAME-004', formatPersonName('JOSÉ DE LA CRUZ Y PÉREZ'), 'José de la Cruz y Pérez')
eq('NAME-005', formatPersonName('ANA-MARIA DOS REIS'), 'Ana-Maria dos Reis')
eq('NAME-006', formatPersonName("PEDRO D'AVILA"), "Pedro D'Avila")
eq('NAME-007', formatPersonName('J. CARLOS SOUZA'), 'J. Carlos Souza')
eq('NAME-008', formatPersonName('LUIZ INÁCIO II'), 'Luiz Inácio II')
eq('NAME-009', formatPersonName('DA SILVA'), 'Da Silva')
eq('NAME-010', formatPersonName('UNDEL'), 'Undel')
eq('NAME-011', formatPersonName('  RITA   LEE  '), '  Rita   Lee  ')
// Lo que ya está bien escrito no se toca (tampoco se inventan acentos)
eq('KEEP-001', formatPersonName('Joao da Silva'), 'Joao da Silva')
eq('KEEP-002', formatPersonName('McDonald Souza'), 'McDonald Souza')
eq('KEEP-003', formatPersonName('maria souza'), 'maria souza')
eq('KEEP-004', formatPersonName('JOAO'), 'Joao')
eq('KEEP-005', formatPersonName('123.456.789-00'), '123.456.789-00')
eq('KEEP-006', formatPersonName(''), '')
eq('KEEP-007', formatPersonName(null), '')
eq('KEEP-008', formatPersonName(undefined), '')
// Negocios: siglas y formas societarias
eq('BIZ-001', formatBusinessName('MERCADINHO JK LTDA'), 'Mercadinho JK LTDA')
eq('BIZ-002', formatBusinessName('BAR DO ZÉ'), 'Bar do Zé')
eq('BIZ-003', formatBusinessName('KFC'), 'KFC')
eq('BIZ-004', formatBusinessName('M&M DOCES'), 'M&M Doces')
eq('BIZ-005', formatBusinessName('PADARIA 2 IRMÃOS'), 'Padaria 2 Irmãos')
eq('BIZ-006', formatBusinessName('Loja Bela'), 'Loja Bela')
// Persona - negocio en el mismo campo (ingresado así)
eq('MIX-001', formatClientName('JOAO FERREIRA DOS SANTOS - MERCADINHO JK'), 'Joao Ferreira dos Santos - Mercadinho JK')
eq('MIX-002', formatClientName('MARIA - BAR DA MARIA LTDA'), 'Maria - Bar da Maria LTDA')
eq('MIX-003', formatClientName('Joao Silva - BAR'), 'Joao Silva - BAR')
eq('MIX-004', formatClientName('PEDRO-PAULO SOUZA'), 'Pedro-Paulo Souza')

console.log(`displayname: ${passed} ✔ · ${failed} ✖`)
if (failed > 0) process.exit(1)
