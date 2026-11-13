// 3.45 (petición del socio, decisión del propietario 2026-11-13): BLOQUEO de la app del Cobrador con PIN.
//
//   · A los 10 minutos sin uso, la app se tapa con una pantalla NEUTRA: fondo liso y teclado numérico, sin logo,
//     colores, nombre de ADEX, nombres ni cifras (que no se sepa de qué app se trata). También se vacía el título.
//   · Se abre con el PIN de 4 dígitos de la EMPRESA (lo define el Administrador en Configuración; inicial 0000).
//     El PIN nunca va en el código: la app se copia su derivación PBKDF2 (`GET /v1/collector-lock`) y lo comprueba
//     en el dispositivo, también SIN SEÑAL.
//   · 5 intentos fallidos = cierre de sesión completo (usuario y contraseña).
//   · El bloqueo solo TAPA la app: debajo sigue montada y el envío de abonos pendientes continúa.
//   · El estado (última actividad, bloqueado, intentos) se guarda por membresía: recargar o reabrir no lo salta.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Delete } from 'lucide-react';
import { api, useRuntime } from './session.ts';

const IDLE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const PIN_LENGTH = 4;

interface LockState { last: number; locked: boolean; fails: number }

const cfgKey = (m: string) => `adex-collector-lock-cfg:${m}`;
const stateKey = (m: string) => `adex-collector-lock:${m}`;

function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento: el bloqueo sigue en memoria */ }
}

/** Derivación guardada en el dispositivo (null = PIN inicial 0000). */
function storedPin(membershipId: string): string | null {
  return read<{ pin: string | null }>(cfgKey(membershipId))?.pin ?? null;
}

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** ¿El PIN corresponde a la derivación de la empresa? Sin derivación, el PIN es el inicial 0000. */
export async function pinMatches(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return pin === '0000';
  const [alg, iterations, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !iterations || !salt || !hash) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: Number(iterations) }, key, 256);
  return b64(bits) === hash;
}

/** Copia en el dispositivo la derivación vigente del PIN (con señal). Sin respuesta, se queda la copia anterior. */
async function refreshPin(membershipId: string): Promise<void> {
  try {
    const r = await api().get<{ pin: string | null }>('/v1/collector-lock');
    write(cfgKey(membershipId), { pin: r.pin ?? null, at: new Date().toISOString() });
  } catch { /* sin señal o API anterior a 0056: se usa la copia guardada */ }
}

export function CollectorLock({ onExhausted }: { onExhausted: () => void }) {
  const membershipId = useRuntime((s) => s.ctx?.membershipId ?? null);
  const online = useRuntime((s) => s.online);
  const [locked, setLocked] = useState(false);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const state = useRef<LockState>({ last: Date.now(), locked: false, fails: 0 });
  const savedAt = useRef(0);

  const persist = useCallback((force = false) => {
    if (!membershipId) return;
    const now = Date.now();
    if (!force && now - savedAt.current < 10_000) return;
    savedAt.current = now;
    write(stateKey(membershipId), state.current);
  }, [membershipId]);

  const lock = useCallback(() => {
    state.current = { ...state.current, locked: true };
    persist(true);
    setEntry('');
    setLocked(true);
  }, [persist]);

  // Estado guardado de esta membresía: bloqueada o inactiva demasiado tiempo → bloqueada al abrir.
  useEffect(() => {
    if (!membershipId) return;
    const saved = read<LockState>(stateKey(membershipId));
    state.current = saved ? { last: saved.last || Date.now(), locked: saved.locked === true, fails: saved.fails || 0 } : { last: Date.now(), locked: false, fails: 0 };
    if (state.current.locked || Date.now() - state.current.last >= IDLE_MS) lock();
    else persist(true);
  }, [membershipId, lock, persist]);

  // Con señal, copia la derivación vigente (al entrar, al recuperar señal y cada 15 minutos).
  useEffect(() => {
    if (!membershipId || !online) return;
    void refreshPin(membershipId);
    const t = setInterval(() => void refreshPin(membershipId), 15 * 60_000);
    return () => clearInterval(t);
  }, [membershipId, online]);

  // Actividad y vigilancia del tiempo sin uso (también al volver de segundo plano, donde los relojes se detienen).
  useEffect(() => {
    if (!membershipId) return;
    const touch = () => {
      if (state.current.locked) return;
      state.current = { ...state.current, last: Date.now() };
      persist();
    };
    const check = () => {
      if (!state.current.locked && Date.now() - state.current.last >= IDLE_MS) lock();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); else persist(true); };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    const onHide = () => persist(true);
    window.addEventListener('pagehide', onHide);
    const t = setInterval(check, 5_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
      clearInterval(t);
    };
  }, [membershipId, lock, persist]);

  // Mientras está bloqueada, la pestaña o el selector de apps no muestran el nombre.
  useEffect(() => {
    if (!locked) return;
    const prev = document.title;
    document.title = '‎';
    return () => { document.title = prev; };
  }, [locked]);

  const submit = useCallback(async (pin: string) => {
    if (!membershipId) return;
    setBusy(true);
    let ok = false;
    try { ok = await pinMatches(pin, storedPin(membershipId)); } catch { ok = false; }
    setBusy(false);
    if (ok) {
      state.current = { last: Date.now(), locked: false, fails: 0 };
      persist(true);
      setEntry('');
      setLocked(false);
      return;
    }
    const fails = state.current.fails + 1;
    if (fails >= MAX_ATTEMPTS) {
      // 5 intentos fallidos: cierre de sesión completo. Los pendientes quedan cifrados en el dispositivo.
      try { localStorage.removeItem(stateKey(membershipId)); } catch { /* nada */ }
      onExhausted();
      return;
    }
    state.current = { ...state.current, fails };
    persist(true);
    setShake(true);
    setTimeout(() => { setShake(false); setEntry(''); }, 450);
  }, [membershipId, onExhausted, persist]);

  const press = (d: string) => {
    if (busy || shake || entry.length >= PIN_LENGTH) return;
    const next = entry + d;
    setEntry(next);
    if (next.length === PIN_LENGTH) void submit(next);
  };

  if (!locked) return null;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <div role="dialog" aria-modal="true" aria-label="PIN" data-testid="collector-lock"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483647, background: '#1c1c1e', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 40, userSelect: 'none', touchAction: 'manipulation' }}
      onContextMenu={(e) => e.preventDefault()}>
      <style>{'@keyframes adexLockShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-10px)}40%,80%{transform:translateX(10px)}}'}</style>
      <div style={{ display: 'flex', gap: 18, animation: shake ? 'adexLockShake .4s' : undefined }} data-testid="collector-lock-dots">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} style={{ width: 14, height: 14, borderRadius: 7, border: '2px solid #d1d1d6', background: i < entry.length ? '#d1d1d6' : 'transparent' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 18 }}>
        {keys.map((k, i) => k === '' ? <span key={i} /> : (
          <button key={i} type="button" data-key={k} aria-label={k === 'del' ? 'borrar' : k}
            onClick={() => (k === 'del' ? setEntry((e) => e.slice(0, -1)) : press(k))}
            style={{ width: 72, height: 72, borderRadius: 36, border: 'none', background: k === 'del' ? 'transparent' : '#2c2c2e',
              color: '#f2f2f7', fontSize: 28, fontWeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            {k === 'del' ? <Delete style={{ width: 26, height: 26 }} /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}
