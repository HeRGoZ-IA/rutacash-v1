// Punto de entrada del contenedor de ADEX Online v1 (ver start.ts).
import { start } from './start.ts';

start().catch((err) => {
  process.stderr.write(`startup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
