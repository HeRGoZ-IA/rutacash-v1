// Registra el resolvedor de alias `@/` de CLEAN para Node (sin compilar).
// Permite que el servidor y las pruebas importen las reglas de `src/lib` tal cual
// (DS-01: reutilizar el motor local como contrato), sin copiarlas ni alterarlas.
import { register } from 'node:module';

register('./alias-hooks.mjs', import.meta.url);
