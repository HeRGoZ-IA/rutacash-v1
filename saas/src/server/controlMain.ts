// Punto de entrada del SERVICIO OWNER (ver controlStart.ts). Misma imagen que la API de
// empresa, otro comando y otras variables de entorno.
import { startControl } from './controlStart.ts';

startControl().catch((err) => {
  process.stderr.write(`startup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
