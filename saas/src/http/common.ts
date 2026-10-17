import type http from 'node:http';
import { ApiError } from '../errors.ts';

const MAX_BODY = 16 * 1024;

/** JSON estricto: objeto, tamaño acotado y solo los campos permitidos. */
export async function readJson(req: http.IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  return checkFields(await readJsonObject(req), allowed);
}

/** Solo los campos permitidos (también para cuerpos que no llegan por HTTP). */
export function checkFields(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, 'UNKNOWN_FIELD', `field "${key}" is not accepted`);
  }
  return body;
}

/** JSON estricto: objeto y tamaño acotado. */
export async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError(400, 'INVALID_JSON');
  return parsed as Record<string, unknown>;
}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function scopeOf(body: Record<string, unknown>): 'local' | 'global' {
  const s = body['scope'] ?? 'local';
  if (s !== 'local' && s !== 'global') throw new ApiError(400, 'INVALID_SCOPE');
  return s;
}
