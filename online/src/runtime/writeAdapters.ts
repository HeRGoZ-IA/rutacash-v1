// Traducciones de escrituras de pantallas de CLEAN → comandos de la API (lista blanca).
// Cada adaptador acepta SOLO la forma exacta que escribe la pantalla original y la
// convierte en el comando del servidor equivalente. Lo que no tiene equivalente se
// rechaza con un mensaje claro; nunca se aplica en el dispositivo ni se ignora en
// silencio un cambio que el usuario pidió.

import { money, OnlineCommandError, plain } from './commands.ts';
import { registerWrites } from './writes.ts';
import { api } from './session.ts';
import { table } from './projection.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Changes = Record<string, any>;

const reject = (msg: string): never => { throw new OnlineCommandError('NOT_SUPPORTED_ONLINE', msg); };
const keysOf = (c: Changes) => Object.keys(c).filter((k) => k !== 'updatedAt');
const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');

async function current(tableName: string, id: string): Promise<Changes> {
  const row = (await table(tableName)).find((r) => r['id'] === id);
  if (!row) throw new OnlineCommandError('NOT_FOUND', 'No encontrado o fuera de su alcance.');
  return row;
}

// ---------- Categorías de gasto (ExpenseCategoriesPage) ----------
registerWrites('expenseCategories', {
  add: (row) => money('POST', '/v1/expense-categories', { name: row['nombre'] }, row['id']),
  update: (id, changes) => {
    const k = keysOf(changes);
    if (k.length === 1 && k[0] === 'nombre') return plain('PATCH', `/v1/expense-categories/${id}`, { name: changes['nombre'] });
    if (k.length === 1 && k[0] === 'activa') return plain('PATCH', `/v1/expense-categories/${id}`, { active: changes['activa'] === true });
    return reject('Ese cambio de categoría no está disponible en ADEX Online.');
  },
  delete: (id) => plain('POST', `/v1/expense-categories/${id}/delete`, {}),
});

// ---------- Datos de la empresa (SettingsPage) ----------
const COMPANY_MAP: Record<string, string> = {
  nombre: 'name', nombreLegal: 'legalName', nit: 'taxId', email: 'email', telefono: 'phone', ciudad: 'city', direccion: 'address', responsable: 'contactName',
};
registerWrites('tenants', {
  update: async (id, changes) => {
    const t = await current('tenants', id);
    // País y moneda son estructurales en el SaaS (definen documentos, moneda y unidades del
    // libro); estado y vencimiento son del plano Owner (DS-17). Si la pantalla pide
    // cambiarlos, se explica en vez de ignorarlo.
    if (!same(changes['pais'] ?? t['pais'], t['pais']) || !same(changes['moneda'] ?? t['moneda'], t['moneda'])) {
      reject('El país y la moneda de la empresa no se cambian desde aquí en ADEX Online: los fija el alta de la empresa.');
    }
    if (('status' in changes && !same(changes['status'], t['status'])) || ('fechaVencimiento' in changes && !same(changes['fechaVencimiento'], t['fechaVencimiento']))) {
      reject('El estado y el vencimiento de la empresa los gestiona el proveedor del servicio (panel Owner).');
    }
    const body: Changes = {};
    for (const [k, v] of Object.entries(changes)) {
      const f = COMPANY_MAP[k];
      if (f && !same(v, t[k])) body[f] = typeof v === 'string' ? v : v ?? null;
    }
    if (Object.keys(body).length === 0) return null;
    return plain('PATCH', '/v1/company', body);
  },
});

// ---------- Clientes (ClientsPage) ----------
const CLIENT_MAP: Record<string, string> = {
  nombre: 'name', documento: 'document', telefonoPrincipal: 'phonePrimary', telefonoSecundario: 'phoneSecondary',
  direccionPrincipal: 'addressPrimary', direccionSecundaria: 'addressSecondary', negocio: 'business', notas: 'notes', routeId: 'routeId',
};
/**
 * Alta de un cliente de CLEAN en el servidor. El id que generó la pantalla es el id de la
 * operación (un reintento devuelve el mismo cliente) y se recuerda su alias: la venta o la
 * solicitud que la pantalla crea a continuación con ese id usa el del servidor.
 * El TIPO de documento lo aporta el formulario (`documentType`, DS-10).
 */
const clientAliases = new Map<string, string>();
export const clientId = (id: string) => clientAliases.get(id) ?? id;

/** Cuerpo del alta de cliente (también el del alta sin conexión de la Ronda 65: el MISMO comando). */
export function clientBodyOf(row: Changes): Changes {
  const documentType = row['documentType'];
  if (!documentType) reject('Indique el tipo de documento del cliente.');
  if ((row['fotoDocumentoUrl'] && !/^https:\/\//.test(row['fotoDocumentoUrl'])) || (row['fotoNegocioUrl'] && !/^https:\/\//.test(row['fotoNegocioUrl']))) {
    reject('Las fotos todavía no se pueden subir en ADEX Online (falta el almacenamiento de archivos en el servidor). Guarde el cliente sin fotos.');
  }
  const body: Changes = { routeId: row['routeId'], documentType, document: row['documento'] };
  for (const [k, f] of Object.entries(CLIENT_MAP)) {
    if (k === 'routeId' || k === 'documento') continue;
    const v = row[k];
    if (typeof v === 'string' && v.trim() !== '') body[f] = v.trim();
  }
  return body;
}

export async function createClientOnline(row: Changes): Promise<string> {
  const body = clientBodyOf(row);
  const created = await money<{ id: string }>('POST', '/v1/clients', body, row['id']);
  if (row['id']) clientAliases.set(String(row['id']), created.id);
  return created.id;
}

registerWrites('clients', {
  add: (row) => createClientOnline(row),
  update: async (id, changes) => {
    const c = await current('clients', id);
    const body: Changes = {};
    for (const [k, v] of Object.entries(changes)) {
      const f = CLIENT_MAP[k];
      if (f && !same(v, c[k])) body[f] = typeof v === 'string' && v.trim() === '' ? null : v;
    }
    // Fotos: el servidor solo admite enlaces https (no hay subida de archivos todavía).
    for (const [k, f] of [['fotoDocumentoUrl', 'documentPhotoUrl'], ['fotoNegocioUrl', 'businessPhotoUrl']] as const) {
      if (k in changes && !same(changes[k], c[k])) {
        const v = changes[k];
        if (v && !/^https:\/\//.test(String(v))) reject('Las fotos todavía no se pueden subir en ADEX Online (falta el almacenamiento de archivos en el servidor).');
        body[f] = v || null;
      }
    }
    if ('document' in body) {
      // Cambiar el número exige reenviar su tipo: se conserva el que ya tiene en el servidor.
      const raw = await api().get<Changes>(`/v1/clients/${id}`);
      body['documentType'] = raw['documentType'];
    }
    if (Object.keys(body).length === 0) return null;
    return plain('PATCH', `/v1/clients/${id}`, body);
  },
  delete: (id) => plain('POST', `/v1/clients/${id}/delete`, {}),
});

// ---------- Usuarios = membresías (UsersPage) ----------
// En el SaaS una persona es una IDENTIDAD con membresías por empresa y rol (DS-05). El id
// que la pantalla de CLEAN genera al crear no es el del servidor: se recuerda el alias
// para las escrituras siguientes de la misma operación (rutas del usuario recién creado).
const aliases = new Map<string, string>();
export const memberId = (id: string) => aliases.get(id) ?? id;

registerWrites('users', {
  add: async (row) => {
    const created = await money<{ membershipId: string }>('POST', '/v1/members', {
      email: row['email'], role: row['rol'], displayName: row['nombre'],
    }, row['id']);
    aliases.set(row['id'], created.membershipId);
    return created.membershipId;
  },
  update: async (rawId, changes) => {
    const id = memberId(rawId);
    const u = await current('users', id);
    const k = keysOf(changes);
    // Estado (activar / desactivar).
    if (k.length === 1 && k[0] === 'status') {
      return plain('POST', `/v1/members/${id}/${changes['status'] === 'activo' ? 'reactivate' : 'deactivate'}`, {});
    }
    // Rutas autorizadas (roles sin cobro): conjunto completo.
    if (k.every((x) => x === 'authorizedRouteIds' || x === 'routeId')) {
      if (u['rol'] === 'superadmin') return null; // el Super Admin no tiene rutas: nada que enviar
      return plain('PUT', `/v1/members/${id}/routes`, { routeIds: changes['authorizedRouteIds'] ?? [] });
    }
    // Datos personales desde el editor.
    if ('email' in changes && !same(String(changes['email']).toLowerCase(), String(u['email']).toLowerCase())) {
      reject('El correo identifica a la persona en ADEX Online y no se cambia aquí.');
    }
    if ('rol' in changes && changes['rol'] !== u['rol']) {
      reject('En ADEX Online el rol es una membresía: para cambiarlo, cree la nueva membresía y desactive la anterior.');
    }
    if (changes['password']) {
      reject('La contraseña la gestiona el proveedor de identidad: la persona la fija con el enlace de acceso enviado a su correo.');
    }
    if ('nombre' in changes && !same(changes['nombre'], u['nombre'])) {
      return plain('PATCH', `/v1/members/${id}`, { displayName: changes['nombre'] });
    }
    return null;
  },
  delete: (id) => plain('POST', `/v1/members/${memberId(id)}/delete`, {}),
});

// ---------- Visitas sin pago (NoPaymentPage) ----------
// Mismo registro que CLEAN; la fecha y quien visita los pone el servidor (0015). El id que
// genera la pantalla es el id de la operación: un doble toque no registra dos visitas.
registerWrites('noPaymentVisits', {
  add: (row) => {
    const body: Changes = { saleId: row['saleId'], reason: row['motivo'] };
    if (row['fechaPromesaPago']) body['promisedPaymentDate'] = row['fechaPromesaPago'];
    if (typeof row['observacion'] === 'string' && row['observacion'].trim()) body['note'] = row['observacion'].trim();
    return money('POST', '/v1/no-payment-visits', body, row['id']);
  },
});
