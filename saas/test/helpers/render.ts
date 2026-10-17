// ADEX Online · arnés para reproducir EN LOCAL las condiciones de Render Free:
//
//   · el servidor REAL (`src/server/main.ts`) como proceso aparte, configurado solo por
//     variables de entorno, con `PORT` asignado, que se puede matar (SIGKILL) y relanzar
//     como una suspensión/reactivación o un reinicio inesperado;
//   · PostgreSQL detrás de un proxy TLS que imita al pooler de Supabase: exige TLS,
//     presenta un certificado propio (verificado con ADEX_PG_SSL_CA_FILE) y permite
//     cortar todas las conexiones o dejar la base inaccesible;
//   · un emisor JWKS local en el lugar de Supabase Auth (`/auth/v1/.well-known/jwks.json`);
//   · un proxy HTTP de fallos entre el cliente y el API: deja pasar la petición, el API
//     la confirma, y la respuesta se pierde o se sustituye por un 503.
//
// ATENCIÓN: esto NO es Render. Reproduce sus efectos sobre el proceso y las conexiones;
// el comportamiento real de la plataforma se verifica tras el despliegue.
// El certificado se genera por ejecución con `openssl` dentro de RutaCash/tmp y se borra.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import type { JSONWebKeySet } from 'jose';

export const saasRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const renderTmp = path.join(saasRoot, '..', 'tmp', 'saas-phase01', 'render');

const OPENSSL_CANDIDATES = [process.env['OPENSSL'], 'openssl', 'C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe'];

export function findOpenssl(): string | null {
  for (const c of OPENSSL_CANDIDATES) {
    if (!c) continue;
    try {
      if (spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0) return c;
    } catch { /* siguiente */ }
  }
  return null;
}

export interface Cert { certPath: string; cert: string; key: string }

/** Certificado autofirmado para 127.0.0.1/localhost (sirve también de CA de sí mismo). */
export function makeCert(openssl: string, dir: string, name: string): Cert {
  mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, `${name}.key`);
  const certPath = path.join(dir, `${name}.crt`);
  const r = spawnSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  return { certPath, cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

export interface PgTlsProxy {
  port: number;
  /** Conexiones abiertas ahora mismo (cliente ↔ proxy). */
  open(): number;
  /** Corta TODAS las conexiones (pooler reiniciado, conexiones viejas tras una suspensión). */
  dropAll(): void;
  /** true: la base deja de ser accesible (cada conexión nueva se corta). */
  setDown(down: boolean): void;
  close(): Promise<void>;
}

/** Proxy que solo admite PostgreSQL con TLS (SSLRequest → 'S' → TLS) hacia la base local. */
export async function startPgTlsProxy(upstreamPort: number, cert: Cert): Promise<PgTlsProxy> {
  const sockets = new Set<net.Socket>();
  let down = false;
  const track = (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => undefined); };
  const server = net.createServer((raw) => {
    track(raw);
    if (down) return void raw.destroy();
    raw.once('data', (first) => {
      raw.pause();
      // SSLRequest: longitud 8 + código 80877103. Sin TLS no se atiende (como el pooler en producción).
      if (first.length !== 8 || first.readInt32BE(4) !== 80877103) return void raw.destroy();
      raw.write('S');
      const secure = new tls.TLSSocket(raw, { isServer: true, key: cert.key, cert: cert.cert });
      const up = net.connect(upstreamPort, '127.0.0.1');
      track(up);
      secure.on('error', () => up.destroy());
      secure.on('close', () => up.destroy());
      up.on('close', () => secure.destroy());
      secure.pipe(up);
      up.pipe(secure);
      raw.resume();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const dropAll = () => { for (const s of [...sockets]) s.destroy(); };
  return {
    port: (server.address() as net.AddressInfo).port,
    open: () => sockets.size,
    dropAll,
    setDown(v) { down = v; if (v) dropAll(); },
    close: () => new Promise<void>((r) => { dropAll(); server.close(() => r()); }),
  };
}

/** Emisor de claves públicas en el lugar de Supabase Auth. */
export async function startJwksHost(jwks: JSONWebKeySet): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(jwks));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface ApiProcess {
  port: number;
  base: string;
  /** ms desde el lanzamiento hasta «adex-online listening». */
  startupMs: number;
  stdout: string[];
  stderr: string[];
  proc: ChildProcess;
  /** Muerte abrupta (sin cierre ordenado): como un reinicio o una suspensión forzada. */
  kill(): Promise<void>;
  /** SIGTERM (Render lo envía antes de parar una instancia). */
  term(): Promise<number | null>;
}

/** Lanza el servidor real con SOLO variables de entorno, en el puerto `PORT` indicado. */
export async function startApiProcess(env: Record<string, string>, port?: number): Promise<ApiProcess> {
  const p = port ?? await freePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('ADEX_') || k.startsWith('SUPABASE_')) delete childEnv[k];
  Object.assign(childEnv, env, { PORT: String(p), NODE_ENV: 'production' });
  const started = Date.now();
  const proc = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', 'src/server/main.ts'], { cwd: saasRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API did not start in 30 s: ${stderr.join('')}`)), 30_000);
    proc.stdout!.on('data', (d: Buffer) => {
      stdout.push(String(d));
      if (String(d).includes('adex-online listening')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr!.on('data', (d: Buffer) => stderr.push(String(d)));
    void exited.then((code) => { clearTimeout(timer); reject(new Error(`API exited (${code}): ${stderr.join('')}`)); });
  });
  const startupMs = Date.now() - started;
  return {
    port: p, base: `http://127.0.0.1:${p}`, startupMs, stdout, stderr, proc,
    async kill() { if (proc.exitCode === null) { proc.kill('SIGKILL'); await exited; } },
    async term() { if (proc.exitCode === null) proc.kill('SIGTERM'); return exited; },
  };
}

/** Lanza el servidor esperando que FALLE al arrancar (configuración inválida). */
export function startApiExpectingFailure(env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('ADEX_') || k.startsWith('SUPABASE_')) delete childEnv[k];
  Object.assign(childEnv, env);
  const proc = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', 'src/server/main.ts'], { cwd: saasRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  proc.stdout!.on('data', (d: Buffer) => { stdout += String(d); });
  proc.stderr!.on('data', (d: Buffer) => { stderr += String(d); });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
  return new Promise((r) => proc.once('exit', (code) => { clearTimeout(timer); r({ code, stderr, stdout }); }));
}

export type Fault = 'drop-after-commit' | '503-after-commit';

/**
 * Proxy HTTP cliente → API. Con un fallo programado, la petición LLEGA al API y se
 * confirma; después la respuesta se pierde (socket cortado) o se sustituye por un 503.
 */
export async function startFaultProxy(target: () => string): Promise<{ base: string; next(f: Fault): void; close(): Promise<void> }> {
  const queue: Fault[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const fault = req.method === 'POST' ? queue.shift() : undefined;
        const headers: Record<string, string> = {};
        for (const h of ['authorization', 'content-type', 'x-adex-membership', 'x-adex-operation-id']) {
          const v = req.headers[h];
          if (typeof v === 'string') headers[h] = v;
        }
        let status = 502;
        let text = '';
        try {
          const r = await fetch(target() + (req.url ?? '/'), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
          status = r.status;
          text = await r.text();
        } catch {
          return void req.socket.destroy();
        }
        if (fault === 'drop-after-commit') return void req.socket.destroy();
        if (fault === '503-after-commit') { res.writeHead(503, { 'content-type': 'application/json' }); return void res.end('{"error":"UNAVAILABLE"}'); }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    next: (f) => { queue.push(f); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function cleanupDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function writeText(p: string, text: string) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}
