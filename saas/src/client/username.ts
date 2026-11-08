// 3.31 · Ingreso con NOMBRE DE USUARIO (petición del socio, aprobada por el propietario el 2026-11-07).
//
// El proveedor de identidad (Supabase Auth) exige un correo. A quien entra con usuario, ADEX le
// asigna un correo INTERNO que nadie ve: `<usuario>@usuarios.adex.invalid`. El dominio `.invalid`
// está reservado (RFC 2606) y nunca recibe correo, así que nadie puede usarlo para recuperar
// la contraseña por correo: ese usuario la cambia con el enlace que le da su administrador (3.20).
//
//   · La casilla de ingreso acepta «usuario» o «correo»: sin arroba es un usuario.
//   · El usuario es ÚNICO EN TODO ADEX (el proveedor no admite dos cuentas con el mismo correo).
//   · Los usuarios con correo real (todos los de BlueLine hasta hoy, y el Owner) siguen igual.
//
// Archivo sin dependencias: lo usan la API, el cliente de sesión y la web.

export const USERNAME_DOMAIN = 'usuarios.adex.invalid';

/** 3 a 30 caracteres: minúsculas, números, punto, guion o guion bajo; empieza y termina en letra o número. */
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/;

/** Correo con el que se autentica lo que la persona escribió en «Usuario o correo». */
export function loginEmailOf(identifier: string): string {
  const t = identifier.trim().toLowerCase();
  return t.includes('@') ? t : `${t}@${USERNAME_DOMAIN}`;
}

/** Usuario de un correo interno; `null` si es un correo real. */
export function usernameOf(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  const suffix = `@${USERNAME_DOMAIN}`;
  return e.endsWith(suffix) ? e.slice(0, -suffix.length) : null;
}

/** Lo que se muestra de una cuenta: el usuario si lo tiene; si no, el correo. */
export function loginLabelOf(email: string | null | undefined): string {
  return usernameOf(email) ?? (email ?? '');
}

/** ¿Es un nombre de usuario válido (sin arroba)? */
export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u.trim().toLowerCase()) && !/[._-]{2}/.test(u);
}

/** Propuesta a partir del nombre: «Carlos Andrés Pérez» → «carlos.perez» (sin acentos). */
export function suggestUsername(name: string): string {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const base = words.length === 1 ? words[0]! : `${words[0]}.${words[words.length - 1]}`;
  return base.slice(0, 30).replace(/[._-]+$/, '');
}
