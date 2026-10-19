// Aprovisionamiento de la EMPRESA DEMO HISTÓRICA (demo-v2-6m) en ADEX-Staging.
//
//   node --import ./scripts/register-alias.mjs scripts/demo-provision.ts --status
//   node --import ./scripts/register-alias.mjs scripts/demo-provision.ts --reset [--days 182]
//
// Usa el MISMO servicio de la Demo que el servidor (`createDemoService`): operador Demo,
// hueco `principal`, escenario ejecutado con la API de empresa normal, conciliación
// obligatoria y retirada de la Demo anterior SOLO si la nueva termina bien (si algo falla,
// la nueva se retira y la anterior se descongela intacta). Corre en este equipo porque
// tarda (miles de comandos) y un servicio gratuito en la nube se suspende sin tráfico.
//
// Personas: los puestos asignables se enlazan con las cuentas ficticias `demo.<rol>@example.test`
// (Ronda 20). Las contraseñas no se tocan ni se imprimen.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../src/db/pgTypes.ts';
import { createSupabaseProvider } from '../src/auth/provider.ts';
import { createTokenVerifier } from '../src/auth/jwt.ts';
import { createCompanyExecutor } from '../src/http/companyApi.ts';
import { createDemoService } from '../src/demo/service.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'hyqaufsagtsucztjfjvc';
const SLOT = 'principal';
const fail = (m: string): never => { console.error(`BLOQUEADO: ${m}`); process.exit(2); };

const readEnv = (f: string) => Object.fromEntries(readFileSync(f, 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1]!, m[2]!.trim()]));
for (const f of ['.env.staging', '.env.online']) if (!existsSync(path.join(root, f))) fail(`falta saas/${f}`);
const env = { ...readEnv(path.join(root, '.env.staging')), ...readEnv(path.join(root, '.env.online')) };
if (env['ADEX_STAGING_PROJECT_REF'] !== STAGING_REF) fail('solo se admite ADEX-Staging');

const PARTICIPANTS: { seat: string; email: string; displayName: string }[] = [
  { seat: 'superadmin-invitado', email: 'demo.superadmin@example.test', displayName: 'Sara SuperAdmin (Demo)' },
  { seat: 'admin-centro', email: 'demo.admin@example.test', displayName: 'Andrés Administrador (Demo)' },
  { seat: 'cobrador-centro', email: 'demo.cobrador@example.test', displayName: 'Carlos Cobrador (Demo)' },
  { seat: 'supervisor-centro', email: 'demo.supervisor@example.test', displayName: 'Sofía Supervisora (Demo)' },
  { seat: 'socio-invitado', email: 'demo.socio@example.test', displayName: 'Pablo Socio (Demo)' },
  { seat: 'secretario-invitado', email: 'demo.secretario@example.test', displayName: 'Elena Secretaria (Demo)' },
];
const OPERATOR = 'demo.operador@example.test';

const args = process.argv.slice(2);
const mode = args[0];
const days = Number(args[args.indexOf('--days') + 1] ?? 182) || 182;
if (!['--status', '--reset', '--abort'].includes(mode ?? '')) fail('uso: --status | --reset [--days N] | --abort');

// TLS estricto si el certificado del proyecto está disponible; si no, el modo de prueba de staging.
const caFile = [env['ADEX_PG_SSL_CA_FILE'], path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt')].find((f) => f && existsSync(f));
const ssl = caFile ? { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
// Tope de 30 s por sentencia pedido al conectar. El pooler de Supabase no lo aplica (rige el
// tope del rol, 2 min); se deja por si se conecta directo. Los 57014 se reintentan igual.
const apiPool = new pg.Pool({ connectionString: env['ADEX_API_DATABASE_URL'], ssl, max: 8, statement_timeout: 30_000, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 20_000 });
const demoPool = new pg.Pool({ connectionString: env['ADEX_DEMO_DATABASE_URL'], ssl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 20_000 });
const provider = createSupabaseProvider({ url: env['SUPABASE_URL']!, publishableKey: env['SUPABASE_PUBLISHABLE_KEY']!, secretKey: env['SUPABASE_SECRET_KEY']! });
const verifyToken = createTokenVerifier({ issuer: `${env['SUPABASE_URL']}/auth/v1` });

const logDir = path.join(root, '..', 'tmp', 'r26', 'demo');
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `provision-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const say = (s: string) => { console.log(s); appendFileSync(logFile, `${s}\n`); };

let lastLog = 0;
const service = createDemoService({
  pool: demoPool, provider, onError: (e) => say(`error: ${(e as Error)?.message ?? e}`),
  execute: createCompanyExecutor({ pool: apiPool, verifyToken, provider }),
  scenario: 'demo-v2-6m', historyDays: days,
  onHistoryProgress: ({ day, index, total, calls }) => {
    if (Date.now() - lastLog < 30_000 && index !== total - 1) return;
    lastLog = Date.now();
    say(`  ${new Date().toISOString().slice(11, 19)} · día ${index + 1}/${total} (${day}) · ${calls} comandos`);
  },
});

try {
  const operator = await provider.ensureIdentity(OPERATOR);
  const claims = { identityId: operator.identityId, sessionId: randomUUID(), iat: Math.floor(Date.now() / 1000) };
  const status = await service.status(claims, SLOT) as Record<string, unknown>;
  const company = status['company'] as { id: string; name: string; scenario: string } | null;
  say(`# Demo · ${new Date().toISOString()} · hueco ${SLOT}: ${status['state']} · empresa ${company?.id ?? '—'} (${company?.scenario ?? '—'}) · TLS ${caFile ? 'estricto' : 'modo de prueba'}`);
  if (mode === '--abort') {
    // Recuperación de una inicialización interrumpida: retira la Demo a medias y reactiva la anterior.
    const pending = status['pendingCompanyId'] as string | null;
    if (!pending) fail('no hay inicialización pendiente');
    const r = await service.abort(claims, SLOT, { companyId: pending, confirm: pending });
    say(`abortada ${pending}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  if (mode === '--reset') {
    if (!company) fail('no hay Demo activa que reiniciar');
    for (const p of PARTICIPANTS) {
      const r = await service.setParticipant(claims, SLOT, p.seat, { email: p.email, displayName: p.displayName });
      say(`  participante ${p.seat} ← ${p.email}: ${r.status}`);
    }
    say(`reinicio con el escenario demo-v2-6m (${days} días): la Demo actual queda congelada hasta que la nueva termine`);
    const started = Date.now();
    const r = await service.reset(claims, SLOT, { companyId: company!.id, confirm: company!.id }, true);
    const body = r.body as Record<string, unknown>;
    say(`resultado ${r.status} · nueva ${body['companyId']} · anterior ${body['previousCompanyId']} · ${Math.round((Date.now() - started) / 60_000)} min`);
    say(`resumen: ${JSON.stringify((body['summary'] ?? body) as unknown).slice(0, 1500)}`);
  }
} catch (e) {
  say(`FALLO: ${(e as Error)?.message ?? e} ${JSON.stringify((e as { details?: unknown }).details ?? '')}`);
  process.exitCode = 1;
} finally {
  await apiPool.end();
  await demoPool.end();
}
