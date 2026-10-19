// Selección de empresa y rol (DS-05). CLEAN no la necesitaba (un usuario = una empresa);
// en el SaaS una persona puede tener varias membresías y debe elegir UNA antes de entrar.
// Se presenta con el MISMO marco visual de la pantalla de acceso de CLEAN (LoginPage:
// fondo, tarjeta, tipografía y botones) para no introducir otra estética.

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, Loader2, LogOut } from 'lucide-react';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { cn } from '@/lib/utils';
import { homePathForRole, ROLE_LABELS } from '@/lib/permissions';
import type { UserRole } from '@/models/types';
import { errorText } from '../lib/format.ts';
import { decideContextOptions, type ChoiceOption } from '../lib/selector.ts';
import { api, selectMembership, signOut, useRuntime } from './session.ts';

export function ContextSelectPage() {
  const navigate = useNavigate();
  const { signedIn, ctx, notice } = useRuntime();
  const [options, setOptions] = useState<ChoiceOption[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    api().memberships()
      .then((list) => setOptions(decideContextOptions(list as Parameters<typeof decideContextOptions>[0])))
      .catch((e) => setError(errorText(e)));
  }, [signedIn]);

  if (!signedIn) return <Navigate to="/login" replace />;
  if (ctx) return <Navigate to={homePathForRole(ctx.role as UserRole)} replace />;

  async function choose(id: string) {
    setBusy(id);
    setError('');
    try {
      const c = await selectMembership(id);
      navigate(homePathForRole(c.role as UserRole));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A8A] via-gray-900 to-[#1E3A8A] flex items-center justify-center p-4">
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-96 h-96 bg-primary-500 rounded-full -translate-x-1/2 -translate-y-1/2 blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary-600 rounded-full translate-x-1/2 translate-y-1/2 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl p-8">
        <div className="mb-6">
          <BrandLogo variant="primary" className="h-11 -ml-1" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Elegir empresa y rol</h2>
        <p className="text-gray-500 text-sm mb-6">Cada sesión opera con una sola membresía. Los permisos no se suman entre roles.</p>

        {notice && <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">{notice}</div>}
        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>}
        {options === null && !error && (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary-600" /></div>
        )}
        {options && options.length === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">No tiene membresías activas.</div>
        )}

        <div className="space-y-2">
          {options?.map((o) => (
            <button
              key={o.membershipId}
              disabled={!o.selectable || busy !== null}
              onClick={() => void choose(o.membershipId)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors',
                o.selectable ? 'border-gray-200 hover:border-primary-300 hover:bg-primary-50' : 'border-gray-100 bg-gray-50 opacity-70 cursor-not-allowed',
              )}
            >
              <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center text-primary-700 flex-shrink-0">
                <Building2 className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{o.companyName}</p>
                <p className="text-xs text-gray-500">{ROLE_LABELS[o.role as UserRole] ?? o.role} · {o.countryCode}{o.isDemo ? ' · Empresa Demo (datos ficticios)' : ''}</p>
                {o.notice && <p className="text-xs text-amber-700 mt-0.5">{o.notice}</p>}
              </div>
              {busy === o.membershipId ? <Loader2 className="w-4 h-4 animate-spin text-primary-600" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
            </button>
          ))}
        </div>

        <button
          onClick={() => void signOut().then(() => navigate('/login'))}
          className="mt-6 w-full flex items-center justify-center gap-2 h-11 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl text-sm transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Cerrar sesión
        </button>
        {/* Sesiones centralizadas: cierra la sesión en todos los dispositivos (revoca en el servidor). */}
        <button
          onClick={() => void signOut('global').then(() => navigate('/login'))}
          className="w-full flex items-center justify-center gap-2 h-9 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl text-xs transition-colors"
        >
          Cerrar sesión en todos los dispositivos
        </button>
      </div>
    </div>
  );
}
