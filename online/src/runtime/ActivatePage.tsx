// ADEX Online (Ronda 40): PRIMER ACCESO y RECUPERACIÓN. Pantalla de llegada de:
//   · el enlace de primer acceso que entrega el Owner (Super Admin) o quien dio de alta al
//     usuario: `/activar#t=<token>` (un solo uso; se canjea al pulsar, no al abrir, para que
//     una vista previa del enlace no lo consuma);
//   · el enlace de «¿Olvidaste tu contraseña?» que envía el proveedor por correo:
//     `/activar#access_token=…&type=recovery`.
// La persona fija SU contraseña directamente en el proveedor de identidad; ADEX no la ve,
// no la guarda y nadie más la conoce. Mismo aspecto que el acceso de CLEAN.

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, KeyRound, CheckCircle } from 'lucide-react';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { api } from './session.ts';

const MIN_LENGTH = 10;

type Link = { kind: 'token'; tokenHash: string } | { kind: 'session'; accessToken: string };

/** Lee el enlace del fragmento y lo BORRA de la barra de direcciones y del historial. */
function takeLink(): Link | null {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  window.history.replaceState(null, '', window.location.pathname);
  const t = p.get('t');
  if (t && /^[0-9a-f]{20,}$/i.test(t)) return { kind: 'token', tokenHash: t };
  const access = p.get('access_token');
  if (access && p.get('type') === 'recovery') return { kind: 'session', accessToken: access };
  return null;
}

const MESSAGES: Record<string, string> = {
  LINK_EXPIRED: 'Este enlace ya se usó o caducó. Pide uno nuevo a quien te dio de alta.',
  WEAK_PASSWORD: 'El proveedor de identidad rechazó la contraseña por débil. Usa una más larga o variada.',
  SAME_PASSWORD: 'Esa ya es tu contraseña. Elige una distinta.',
  NETWORK: 'Sin conexión. Revisa tu internet e intenta de nuevo.',
};

export function ActivatePage() {
  const [link] = useState<Link | null>(() => takeLink());
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  // Un token de un solo uso se canjea una vez; si después falla la contraseña, se reintenta
  // con la sesión temporal ya obtenida (en memoria, nunca guardada).
  const [session, setSession] = useState<string | null>(link?.kind === 'session' ? link.accessToken : null);

  useEffect(() => () => { setPassword(''); setConfirm(''); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_LENGTH) { setError(`La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`); return; }
    if (password !== confirm) { setError('La contraseña y su confirmación no coinciden.'); return; }
    if (!link) return;
    setLoading(true);
    setError('');
    try {
      let token = session;
      if (!token && link.kind === 'token') { token = await api().redeemAccessLink(link.tokenHash); setSession(token); }
      await api().setOwnPassword(token!, password);
      setDone(true);
    } catch (err) {
      setError(MESSAGES[(err as { code?: string })?.code ?? ''] ?? 'No se pudo fijar la contraseña. Intenta de nuevo.');
    } finally {
      setLoading(false);
      setPassword('');
      setConfirm('');
    }
  }

  const input = 'w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent';

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A8A] via-gray-900 to-[#1E3A8A] flex items-center justify-center p-4">
      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <BrandLogo variant="on-dark" className="h-14" />
          <p className="text-primary-300 text-sm mt-1">Sistema de rutas y cobros</p>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-8">
          {done ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-emerald-600" />
                <h1 className="text-2xl font-bold text-gray-900">Contraseña fijada</h1>
              </div>
              <p className="text-gray-500 text-sm">Ya puedes entrar con tu correo y la contraseña que acabas de elegir.</p>
              <a href="/login" className="w-full h-11 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium text-sm flex items-center justify-center">
                Iniciar sesión
              </a>
            </div>
          ) : !link ? (
            <div className="space-y-4">
              <h1 className="text-2xl font-bold text-gray-900">Enlace no válido</h1>
              <p className="text-gray-500 text-sm">Abre el enlace completo que recibiste. Si ya lo usaste o caducó, pide uno nuevo a quien te dio de alta.</p>
              <a href="/login" className="text-primary-600 text-sm font-medium hover:underline">Ir al inicio de sesión</a>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <KeyRound className="w-5 h-5 text-gray-700" />
                <h1 className="text-2xl font-bold text-gray-900">Fija tu contraseña</h1>
              </div>
              <p className="text-gray-500 text-sm mb-6">
                Elige una contraseña privada (mínimo {MIN_LENGTH} caracteres). Solo tú la conocerás: ADEX no la guarda.
              </p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nueva contraseña</label>
                  <div className="relative">
                    <input type={showPass ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password" className={`${input} pr-11`} />
                    <button type="button" onClick={() => setShowPass(!showPass)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirmar contraseña</label>
                  <input type={showPass ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password" className={input} />
                </div>
                {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>}
                <button type="submit" disabled={loading}
                  className="w-full h-11 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {loading ? 'Guardando...' : 'Guardar contraseña'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
