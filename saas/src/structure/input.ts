// Validación estricta de entradas de los comandos de estructura y catálogo. Cada
// campo tiene tipo y límite; lo que no cumple se rechaza (400), nunca se «arregla».

import { ApiError } from '../errors.ts';
import { ID_RE } from '../authz/context.ts';

const MAX_TEXT = 200;

/** Texto obligatorio, recortado, no vacío. */
export function reqText(body: Record<string, unknown>, key: string, max = MAX_TEXT): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new ApiError(400, 'INVALID_INPUT', `${key} is required`, { field: key });
  return v.trim();
}

/** Texto opcional: ausente o `null` → null; vacío → null. */
export function optText(body: Record<string, unknown>, key: string, max = MAX_TEXT): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim().length > max) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`, { field: key });
  return v.trim() || null;
}

/** ¿El cuerpo trae el campo? (para PATCH: ausente = no cambia). */
export function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function reqId(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`, { field: key });
  return v;
}

export function optId(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`, { field: key });
  return v;
}

export function idList(body: Record<string, unknown>, key: string, max = 500): string[] {
  const v = body[key] ?? [];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) {
    throw new ApiError(400, 'INVALID_INPUT', `${key} must be a list of ids`, { field: key });
  }
  return [...new Set(v as string[])];
}

export function bool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  if (typeof v !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', `${key} must be boolean`, { field: key });
  return v;
}

/** Entero ≥ 0 en unidades menores de la moneda (sin decimales ni redondeos). */
export function minor(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApiError(400, 'INVALID_INPUT', `${key} must be a non-negative integer (minor units)`, { field: key });
  return v;
}

/** Tasa porcentual ≥ 0 con hasta 4 decimales (`routes.interest_rate numeric(9,4)`). */
export function rate(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000 || Math.round(v * 10_000) !== v * 10_000) {
    throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`, { field: key });
  }
  return v;
}

export function oneOf<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T {
  const v = body[key];
  if (typeof v !== 'string' || !values.includes(v as T)) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`, { field: key });
  return v as T;
}

/** Id de un recurso de la URL: uno mal formado es indistinguible de uno inexistente. */
export function pathId(id: string): string {
  if (!ID_RE.test(id)) throw new ApiError(404, 'NOT_FOUND');
  return id;
}
