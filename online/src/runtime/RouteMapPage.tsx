// MAPA DE RUTAS (Ronda 67 · Entrega B): el Administrador consulta en un mapa las ubicaciones
// CONOCIDAS de los clientes de sus rutas y el resultado de la actividad registrada.
//
//   · Un marcador por cliente con ubicación de REFERENCIA, con el resultado más reciente del filtro:
//     bolsa = venta o crédito, check verde = abono válido, X roja = visita sin pago, punto gris = sin
//     actividad en el periodo. El detalle lista toda la actividad del cliente en el filtro.
//   · La ubicación del DISPOSITIVO al registrar (abono o venta) es otra capa, opcional y rotulada:
//     nunca se confunde con la del cliente.
//   · Clientes sin ubicación: no se dibujan en ningún punto inventado; se cuentan y se pueden
//     ubicar marcando el lugar en el mapa (origen «punto en el mapa», auditado).
//   · «Última actividad conocida»: la última operación registrada con ubicación del dispositivo, con
//     su fecha. No hay seguimiento continuo ni posición en tiempo real.
//   · El área de cada ruta es una ayuda visual (contorno de sus clientes), no un recorrido.
//
// Cartografía: Leaflet (BSD) con teselas de OpenStreetMap. Las teselas solo reciben el área que se
// mira (zoom y cuadrícula) y el origen del sitio, nunca datos de clientes ni coordenadas exactas.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Crosshair, MapPin, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters';
import { formatClientName, formatPersonName } from '@/lib/displayName';
import { generateId } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { api } from './session.ts';
import { money } from './commands.ts';
import { toMajor } from './mappers.ts';
import { geocoder, PRECISION_LABEL, type GeocodeResult } from './geocoding.ts';
import { useRuntime } from './session.ts';

type Kind = 'sale' | 'payment' | 'visit';
interface Device { status: string; lat: number | null; lng: number | null; accuracyM: number | null; capturedAt: string | null; receivedAt: string | null }
interface LocationHistory { source: string; setAt: string; setByName: string | null; accuracyM: number | null; note?: string | null }
interface MapClient {
  id: string; name: string; routeId: string; address: string; addressSecondary: string | null; status: string;
  location: null | { source: 'gps_on_site' | 'map_pin'; lat: number; lng: number; accuracyM: number | null; setAt: string; setBy: string; setByName: string | null; setByRole: string };
}
interface Activity {
  kind: Kind; id: string; clientId: string; routeId: string; day: string; at: string; workerId: string;
  amountMinor?: number; reason?: string; promisedPaymentDate?: string | null; saleStatus?: string;
  registeredBy?: string; deliveredBy?: string | null; device: Device | null; deviceOrigin?: string | null;
}
interface LastKnown { workerId: string; kind: Kind; id: string; clientId: string; routeId: string; at: string; lat: number; lng: number; accuracyM: number | null }
interface MapData {
  from: string; to: string; today: string;
  routes: { id: string; name: string; status: string }[];
  workers: { id: string; name: string; role: string; status: string }[];
  clients: MapClient[]; activities: Activity[]; lastKnown: LastKnown[]; truncated: boolean;
}

const KIND_LABEL: Record<Kind, string> = { sale: 'Venta', payment: 'Recaudo', visit: 'Visita sin pago' };
const REASON_LABEL: Record<string, string> = {
  no_estaba: 'No estaba', sin_dinero: 'Sin dinero', negocio_cerrado: 'Negocio cerrado', promesa_pago: 'Promesa de pago', otro: 'Otro motivo',
};
const ROLE_LABEL: Record<string, string> = { cobrador: 'Cobrador', supervisor: 'Supervisor', admin: 'Administrador', secretario: 'Secretario', superadmin: 'SuperAdmin' };
const ROUTE_COLORS = ['#2563eb', '#9333ea', '#ea580c', '#0d9488', '#be123c', '#4d7c0f', '#0369a1', '#a16207'];
const DEFAULT_VIEW: L.LatLngExpression = [4.6, -74.08];   // solo el encuadre inicial sin puntos; nunca se dibuja nada ahí

/** Marcadores aprobados: bolsa, check verde, X roja; gris = cliente ubicado sin actividad en el filtro. */
const ICON_SVG: Record<Kind | 'none', string> = {
  sale: '<circle cx="16" cy="16" r="14" fill="#f59e0b" stroke="#fff" stroke-width="2"/><path d="M12.5 9.5h7l-1.6 2.6c3 1.4 4.6 4.1 4.6 6.9 0 2.7-2.3 4.5-6.5 4.5s-6.5-1.8-6.5-4.5c0-2.8 1.6-5.5 4.6-6.9z" fill="#fff"/><text x="16" y="21.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="#b45309" font-family="system-ui">$</text>',
  payment: '<circle cx="16" cy="16" r="14" fill="#16a34a" stroke="#fff" stroke-width="2"/><path d="M10 16.5l4 4 8-9" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  visit: '<circle cx="16" cy="16" r="14" fill="#dc2626" stroke="#fff" stroke-width="2"/><path d="M11 11l10 10M21 11l-10 10" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>',
  none: '<circle cx="16" cy="16" r="8" fill="#9ca3af" stroke="#fff" stroke-width="2"/>',
};
const iconOf = (k: Kind | 'none', ring?: string) => L.divIcon({
  className: 'adex-map-icon',
  html: `<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">${ring ? `<circle cx="16" cy="16" r="15.5" fill="none" stroke="${ring}" stroke-width="1.5"/>` : ''}${ICON_SVG[k]}</svg>`,
  iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14],
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};
/** Contorno convexo (monotone chain): el área aproximada de los clientes ubicados de una ruta. */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export default function RouteMapPage() {
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeId, setRouteId] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ sale: true, payment: true, visit: true });
  const [showDevice, setShowDevice] = useState(false);
  const [showAreas, setShowAreas] = useState(true);
  const [picking, setPicking] = useState<MapClient | null>(null);
  const [pinned, setPinned] = useState<{ client: MapClient; lat: number; lng: number } | null>(null);
  const [note, setNote] = useState('');
  // Ronda 73 · SOC-06: punto PROVISIONAL (arrastrable) antes de confirmar, su origen y el historial del cliente.
  const [draft, setDraft] = useState<{ lat: number; lng: number; fromAddress?: GeocodeResult } | null>(null);
  const [history, setHistory] = useState<LocationHistory[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const draftRef = useRef<L.Marker | null>(null);
  const [saving, setSaving] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const fittedRef = useRef('');
  // Solo la respuesta de la ÚLTIMA consulta se pinta: con filtros cambiados seguidos, una respuesta
  // anterior que llegue tarde no puede sobrescribir el resultado vigente.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true); setError(null);
    try {
      const q = new URLSearchParams();
      if (routeId) q.set('routeId', routeId);
      if (workerId) q.set('workerId', workerId);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const selected = (Object.keys(kinds) as Kind[]).filter((k) => kinds[k]);
      if (selected.length && selected.length < 3) q.set('kinds', selected.join(','));
      const body = await api().get<MapData>(`/v1/map${q.size ? `?${q}` : ''}`);
      if (seq !== seqRef.current) return;
      setData(body);
      if (!from) setFrom(body.from);
      if (!to) setTo(body.to);
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, workerId, from, to, kinds]);
  useEffect(() => { void load(); }, [load]);

  // Mapa (una vez). Sin seguimiento: nada pide la ubicación del navegador aquí.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { zoomControl: true, attributionControl: true }).setView(DEFAULT_VIEW, 5);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      // La página usa «no-referrer»; las teselas solo envían el ORIGEN del sitio (política de uso de OSM), nunca la ruta.
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    let failures = 0;
    tiles.on('tileerror', () => { failures += 1; if (failures >= 4) setTilesFailed(true); });
    tiles.on('tileload', () => { failures = 0; setTilesFailed(false); });
    tiles.addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  const routeName = useMemo(() => new Map((data?.routes ?? []).map((r) => [r.id, r.name])), [data]);
  const workerName = useMemo(() => new Map((data?.workers ?? []).map((w) => [w.id, `${formatPersonName(w.name)} (${ROLE_LABEL[w.role] ?? w.role})`])), [data]);
  const routeColor = useMemo(() => new Map((data?.routes ?? []).map((r, i) => [r.id, ROUTE_COLORS[i % ROUTE_COLORS.length]!])), [data]);
  const byClient = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of data?.activities ?? []) { const l = m.get(a.clientId) ?? []; l.push(a); m.set(a.clientId, l); }
    return m;   // la API ya las entrega de la más reciente a la más antigua
  }, [data]);
  const located = useMemo(() => (data?.clients ?? []).filter((c) => c.location), [data]);
  const missing = useMemo(() => (data?.clients ?? []).filter((c) => !c.location), [data]);
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { sale: 0, payment: 0, visit: 0 };
    for (const a of data?.activities ?? []) c[a.kind] += 1;
    return c;
  }, [data]);

  const popupHtml = useCallback((c: MapClient) => {
    const acts = byClient.get(c.id) ?? [];
    const loc = c.location!;
    const origin = loc.source === 'gps_on_site' ? 'GPS del dispositivo en el lugar del cliente' : 'punto marcado en el mapa';
    const rows = acts.slice(0, 12).map((a) => {
      const what = a.kind === 'visit' ? `${KIND_LABEL.visit}: ${esc(REASON_LABEL[a.reason ?? ''] ?? a.reason)}${a.promisedPaymentDate ? ` · promete ${esc(formatDate(a.promisedPaymentDate))}` : ''}`
        : `${KIND_LABEL[a.kind]}${a.amountMinor != null ? ` · ${esc(formatCurrency(toMajor(a.amountMinor)))}` : ''}`;
      const dev = a.device?.status === 'captured' && a.device.lat != null && a.device.lng != null
        ? `Dispositivo a ${metres(loc, { lat: a.device.lat, lng: a.device.lng })} m de la referencia${a.device.accuracyM != null ? ` (±${a.device.accuracyM} m)` : ''}`
        : a.kind === 'visit' ? 'Sin GPS propio: se muestra en la ubicación del cliente' : a.device ? 'Sin ubicación del dispositivo' : 'Ubicación del dispositivo no registrada';
      return `<li style="margin:4px 0;padding-top:4px;border-top:1px solid #f3f4f6"><b>${esc(formatDateTime(a.at))}</b> · ${what}<br><span style="color:#6b7280">${esc(workerName.get(a.workerId) ?? 'Trabajador')} · ${esc(dev)}</span></li>`;
    }).join('');
    return `<div style="min-width:220px;max-width:300px;font-size:12px;line-height:1.35">
      <div style="font-weight:700;font-size:13px">${esc(formatClientName(c.name))}</div>
      <div style="color:#6b7280">${esc(routeName.get(c.routeId) ?? '')} · ${esc(c.address)}</div>
      <div style="margin-top:4px;color:#374151">Ubicación de referencia: ${esc(origin)}${loc.setByName ? `, por ${esc(formatPersonName(loc.setByName))}` : ''} el ${esc(formatDate(loc.setAt))}</div>
      ${acts.length ? `<div style="margin-top:6px;font-weight:600">Actividad en el periodo (${acts.length})</div><ul style="list-style:none;padding:0;margin:0">${rows}</ul>${acts.length > 12 ? `<div style="color:#6b7280">… y ${acts.length - 12} más</div>` : ''}`
        : '<div style="margin-top:6px;color:#6b7280">Sin actividad en el periodo filtrado.</div>'}
      <button type="button" data-fix="${esc(c.id)}" style="margin-top:8px;color:#2563eb;font-weight:600;background:none;border:0;padding:0;cursor:pointer">Corregir ubicación en el mapa</button>
    </div>`;
  }, [byClient, routeName, workerName]);

  // Capas: áreas de ruta, un marcador por cliente ubicado y, si se pide, los puntos del dispositivo.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer || !data) return;
    layer.clearLayers();
    markersRef.current.clear();
    if (showAreas) {
      for (const r of data.routes) {
        const pts = located.filter((c) => c.routeId === r.id).map((c) => [c.location!.lat, c.location!.lng] as [number, number]);
        if (pts.length < 3) continue;
        L.polygon(hull(pts), { color: routeColor.get(r.id), weight: 1.5, dashArray: '4 4', fillOpacity: 0.05, interactive: false }).addTo(layer);
      }
    }
    for (const c of located) {
      const last = byClient.get(c.id)?.[0];
      const m = L.marker([c.location!.lat, c.location!.lng], { icon: iconOf(last?.kind ?? 'none', routeColor.get(c.routeId)), title: formatClientName(c.name), keyboard: true })
        .bindPopup(() => popupHtml(c), { maxWidth: 320 });
      m.addTo(layer);
      markersRef.current.set(c.id, m);
    }
    if (showDevice) {
      for (const a of data.activities) {
        if (a.device?.status !== 'captured' || a.device.lat == null || a.device.lng == null) continue;
        L.circleMarker([a.device.lat, a.device.lng], { radius: 5, color: '#111827', weight: 1.5, fillColor: '#fff', fillOpacity: 0.9 })
          .bindPopup(`<div style="font-size:12px"><b>Ubicación del DISPOSITIVO</b> (no es la del cliente)<br>${esc(KIND_LABEL[a.kind])} · ${esc(formatDateTime(a.at))}<br>${esc(workerName.get(a.workerId) ?? '')}${a.device.accuracyM != null ? `<br>Precisión ±${a.device.accuracyM} m` : ''}</div>`)
          .addTo(layer);
      }
    }
    const key = `${data.routes.map((r) => r.id).join(',')}|${routeId}`;
    if (located.length && fittedRef.current !== key) {
      fittedRef.current = key;
      map.fitBounds(L.latLngBounds(located.map((c) => [c.location!.lat, c.location!.lng] as [number, number])), { padding: [32, 32], maxZoom: 16 });
    }
  }, [data, located, byClient, showDevice, showAreas, routeColor, popupHtml, workerName, routeId]);

  // «Corregir ubicación» dentro del detalle de un marcador.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onOpen = (e: L.PopupEvent) => {
      const btn = e.popup.getElement()?.querySelector<HTMLButtonElement>('[data-fix]');
      if (!btn) return;
      btn.onclick = () => {
        const c = data?.clients.find((x) => x.id === btn.dataset['fix']);
        if (c) { map.closePopup(); setPicking(c); }
      };
    };
    map.on('popupopen', onOpen);
    return () => { map.off('popupopen', onOpen); };
  }, [data]);

  // Modo «marcar el lugar»: el siguiente clic en el mapa propone la ubicación (se confirma después).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !picking) return;
    const el = map.getContainer();
    el.style.cursor = 'crosshair';
    const onClick = (e: L.LeafletMouseEvent) => setDraft({ lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) });
    map.on('click', onClick);
    // Centrar en los clientes ya ubicados de su ruta (ayuda a encontrar la dirección escrita).
    const near = (data?.clients ?? []).filter((c) => c.routeId === picking.routeId && c.location);
    if (near.length) map.fitBounds(L.latLngBounds(near.map((c) => [c.location!.lat, c.location!.lng] as [number, number])), { padding: [32, 32], maxZoom: 16 });
    // Historial auditado de su ubicación de referencia.
    setHistory(null);
    void api().get<{ history: LocationHistory[] }>(`/v1/clients/${encodeURIComponent(picking.id)}/location`)
      .then((r) => setHistory(r.history)).catch(() => setHistory([]));
    return () => { map.off('click', onClick); el.style.cursor = ''; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  // Marcador provisional: se corrige arrastrándolo o tocando otro punto; nada se guarda sin confirmar.
  useEffect(() => {
    const map = mapRef.current;
    draftRef.current?.remove();
    draftRef.current = null;
    if (!map || !draft) return;
    const icon = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 28],
      html: '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z" fill="#2563eb" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>' });
    const m = L.marker([draft.lat, draft.lng], { draggable: true, icon, title: 'Ubicación propuesta: arrástrela para corregirla', zIndexOffset: 1000 }).addTo(map);
    m.on('dragend', () => { const p = m.getLatLng(); setDraft((d) => (d ? { ...d, lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) } : d)); });
    draftRef.current = m;
    return () => { m.remove(); };
  }, [draft]);

  const stopPicking = () => { setPicking(null); setDraft(null); setResults(null); setQuery(''); setHistory(null); };

  const search = async () => {
    if (!geocoder || !query.trim()) return;
    setSearching(true);
    try {
      const country = useRuntime.getState().ctx?.company.countryCode ?? '';
      const c = mapRef.current?.getCenter();
      setResults(await geocoder.search(query.trim(), { countryCode: country, ...(c ? { near: { lat: c.lat, lng: c.lng } } : {}) }));
    } catch {
      setResults([]);
    } finally { setSearching(false); }
  };

  const savePin = async () => {
    if (!pinned) return;
    setSaving(true);
    try {
      // Desde una dirección: queda como punto en el mapa (aproximado), nunca como GPS confirmado.
      const origin = draft?.fromAddress ? `Desde la dirección «${draft.fromAddress.label}» (${PRECISION_LABEL[draft.fromAddress.precision]}), confirmada a mano.` : '';
      const fullNote = [origin, note.trim()].filter(Boolean).join(' ').slice(0, 200);
      await money('POST', `/v1/clients/${pinned.client.id}/location`, { source: 'map_pin', lat: pinned.lat, lng: pinned.lng, ...(fullNote ? { note: fullNote } : {}) }, generateId());
      toast.success(`Ubicación de ${formatClientName(pinned.client.name)} guardada (marcada en el mapa).`);
      setPinned(null); stopPicking(); setNote('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const focus = (lat: number, lng: number, clientId?: string) => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
    const m = clientId ? markersRef.current.get(clientId) : undefined;
    if (m) m.openPopup();
    else L.popup().setLatLng([lat, lng]).setContent('<div style="font-size:12px">Ubicación del dispositivo en esa operación</div>').openOn(map);
    mapEl.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const routeOptions = [{ value: '', label: 'Todas mis rutas' }, ...(data?.routes ?? []).map((r) => ({ value: r.id, label: r.status === 'activa' || !r.status ? r.name : `${r.name} (${r.status})` }))];
  const workerOptions = [{ value: '', label: 'Todos los trabajadores' }, ...(data?.workers ?? []).filter((w) => w.role !== 'admin' || w.id === workerId)
    .map((w) => ({ value: w.id, label: `${formatPersonName(w.name)} · ${ROLE_LABEL[w.role] ?? w.role}` }))];

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="route-map-page">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Mapa de rutas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Clientes con ubicación conocida y resultado de la actividad registrada. No es seguimiento en tiempo real.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading} icon={<RefreshCw className="w-3.5 h-3.5" />}>Actualizar</Button>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-3 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 items-end">
        <Select label="Ruta" value={routeId} onChange={(e) => setRouteId(e.target.value)} options={routeOptions} data-testid="map-route" />
        <Select label="Trabajador" value={workerId} onChange={(e) => setWorkerId(e.target.value)} options={workerOptions} data-testid="map-worker" />
        <Input label="Desde" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} data-testid="map-from" />
        <Input label="Hasta" type="date" value={to} min={from || undefined} max={data?.today} onChange={(e) => setTo(e.target.value)} data-testid="map-to" />
        <fieldset className="flex flex-wrap gap-1.5" aria-label="Tipo de actividad">
          {(['sale', 'payment', 'visit'] as Kind[]).map((k) => (
            <button key={k} type="button" aria-pressed={kinds[k]} data-testid={`map-kind-${k}`}
              onClick={() => setKinds((s) => ({ ...s, [k]: !s[k] }))}
              className={cn('inline-flex items-center gap-1 min-h-[36px] px-2 rounded-lg border text-xs font-medium',
                kinds[k] ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500')}>
              <span className="inline-block w-4 h-4" dangerouslySetInnerHTML={{ __html: `<svg width="16" height="16" viewBox="0 0 32 32">${ICON_SVG[k]}</svg>` }} />
              {KIND_LABEL[k]}
            </button>
          ))}
        </fieldset>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
      {data?.truncated && <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Hay más registros de los que se muestran. Acote el filtro (ruta, trabajador o fechas).</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-2">
          {picking && (
            <div className="rounded-xl border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-800 space-y-2" data-testid="map-picking">
              <div className="flex items-start justify-between gap-2">
                <span><Crosshair className="inline w-4 h-4 mr-1" />{draft ? 'Ajuste el marcador azul arrastrándolo (o toque otro punto) y confirme:' : 'Toque en el mapa el lugar donde se atiende a'} <b>{formatClientName(picking.name)}</b>.</span>
                <Button variant="ghost" size="sm" onClick={stopPicking}>Cancelar</Button>
              </div>
              <p className="text-xs text-primary-900" data-testid="map-picking-address">Dirección registrada: <b>{picking.address}</b>{picking.addressSecondary ? <> · Cobro: <b>{picking.addressSecondary}</b></> : null}</p>
              {geocoder && (
                <div className="space-y-1">
                  <div className="flex gap-2">
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar dirección" aria-label="Buscar dirección" />
                    <Button variant="secondary" size="sm" onClick={() => void search()} loading={searching}>Buscar</Button>
                  </div>
                  {results && (results.length === 0
                    ? <p className="text-xs">Sin resultados: marque el punto a mano.</p>
                    : <ul className="max-h-40 overflow-y-auto divide-y divide-primary-100 bg-white rounded-lg border border-primary-100">
                        {results.map((r, i) => (
                          <li key={i}><button type="button" className="w-full text-left px-2 py-1.5 text-xs hover:bg-primary-50"
                            onClick={() => { setDraft({ lat: r.lat, lng: r.lng, fromAddress: r }); mapRef.current?.setView([r.lat, r.lng], 18); }}>
                            {r.label} <span className="text-gray-500">· {PRECISION_LABEL[r.precision]}</span></button></li>
                        ))}
                      </ul>)}
                  {results && results.length > 1 && <p className="text-xs">Varias coincidencias: elija la correcta y ajuste el marcador.</p>}
                  <p className="text-[11px] text-primary-700">Resultados de {geocoder.name}: siempre aproximados hasta que usted confirme el punto.</p>
                </div>
              )}
              {draft && (
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setPinned({ client: picking, lat: draft.lat, lng: draft.lng })} data-testid="map-draft-confirm">Confirmar este punto</Button>
                </div>
              )}
            </div>
          )}
          <div className="relative">
            <div ref={mapEl} className="h-[60vh] min-h-[360px] w-full rounded-2xl border border-gray-200 overflow-hidden z-0" data-testid="map-canvas" />
            {tilesFailed && <div className="absolute bottom-2 left-2 right-2 rounded-lg bg-white/95 border border-amber-200 px-2 py-1 text-xs text-amber-800 z-[500]">No se pudo cargar el fondo cartográfico; los marcadores siguen siendo correctos.</div>}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-gray-600">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={showAreas} onChange={(e) => setShowAreas(e.target.checked)} data-testid="map-areas" />Área aproximada de cada ruta (ayuda visual, no es un recorrido)</label>
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={showDevice} onChange={(e) => setShowDevice(e.target.checked)} data-testid="map-device" /><Smartphone className="w-3.5 h-3.5" />Ubicación del dispositivo al registrar (no es la del cliente)</label>
          </div>
        </div>

        <aside className="space-y-3">
          <section className="bg-white rounded-2xl border border-gray-100 shadow-card p-3 text-sm" data-testid="map-summary">
            <h2 className="font-semibold text-gray-900 mb-2">Resumen del filtro</h2>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
              <dt className="text-gray-500">Clientes ubicados</dt><dd className="text-right font-medium" data-testid="map-located">{located.length}</dd>
              <dt className="text-gray-500">Sin ubicación</dt><dd className="text-right font-medium text-amber-700" data-testid="map-missing">{missing.length}</dd>
              {(['sale', 'payment', 'visit'] as Kind[]).map((k) => (<Fragment key={k}><dt className="text-gray-500">{KIND_LABEL[k]}</dt><dd className="text-right font-medium" data-testid={`map-count-${k}`}>{counts[k]}</dd></Fragment>))}
            </dl>
            {data && <p className="mt-2 text-xs text-gray-500">Del {formatDate(data.from)} al {formatDate(data.to)}.</p>}
            {missing.length > 0 && (
              <div className="mt-2">
                <button type="button" className="text-xs font-semibold text-primary-700" onClick={() => setMissingOpen((v) => !v)} data-testid="map-missing-toggle">
                  <AlertTriangle className="inline w-3.5 h-3.5 mr-1 text-amber-600" />{missingOpen ? 'Ocultar' : 'Ver'} clientes sin ubicación
                </button>
                {missingOpen && (
                  <ul className="mt-2 max-h-56 overflow-y-auto divide-y divide-gray-50" data-testid="map-missing-list">
                    {missing.map((c) => (
                      <li key={c.id} className="py-1.5 flex items-center justify-between gap-2">
                        <span className="min-w-0"><span className="block truncate font-medium text-gray-800">{formatClientName(c.name)}</span><span className="block truncate text-xs text-gray-500">{routeName.get(c.routeId)} · {c.address}{(byClient.get(c.id)?.length ?? 0) > 0 ? ` · ${byClient.get(c.id)!.length} actividad(es)` : ''}</span></span>
                        <Button variant="ghost" size="sm" onClick={() => setPicking(c)} icon={<MapPin className="w-3.5 h-3.5" />}>Ubicar</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="bg-white rounded-2xl border border-gray-100 shadow-card p-3 text-sm" data-testid="map-last-known">
            <h2 className="font-semibold text-gray-900">Última actividad conocida</h2>
            <p className="text-xs text-gray-500 mb-2">Última operación registrada con ubicación del dispositivo. No es una ubicación en tiempo real.</p>
            {(data?.lastKnown ?? []).length === 0 ? <p className="text-xs text-gray-500">Sin operaciones con ubicación.</p> : (
              <ul className="space-y-2">
                {data!.lastKnown.map((k) => (
                  <li key={k.workerId} className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-xs"><span className="block font-medium text-gray-800 truncate">{workerName.get(k.workerId) ?? 'Trabajador'}</span>
                      <span className="block text-gray-500">{KIND_LABEL[k.kind]} · {formatDateTime(k.at)} · {routeName.get(k.routeId) ?? ''}</span></span>
                    <Button variant="ghost" size="sm" onClick={() => focus(k.lat, k.lng)}>Ver</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-white rounded-2xl border border-gray-100 shadow-card p-3 text-xs text-gray-600 space-y-1">
            <h2 className="font-semibold text-gray-900 text-sm">Leyenda</h2>
            {(['sale', 'payment', 'visit', 'none'] as const).map((k) => (
              <div key={k} className="flex items-center gap-2"><span className="inline-block w-5 h-5" dangerouslySetInnerHTML={{ __html: `<svg width="20" height="20" viewBox="0 0 32 32">${ICON_SVG[k]}</svg>` }} />
                {k === 'none' ? 'Cliente ubicado sin actividad en el periodo' : `${KIND_LABEL[k]} (resultado más reciente)`}</div>
            ))}
            <p className="pt-1">Cada marcador está en la ubicación de referencia del cliente. Una visita sin pago no tiene GPS propio: la X indica el resultado, no la presencia exacta.</p>
          </section>
        </aside>
      </div>

      <Modal open={Boolean(pinned)} onClose={() => { if (!saving) setPinned(null); }} title="Ubicación de referencia del cliente" size="sm"
        footer={<><Button variant="secondary" onClick={() => setPinned(null)} disabled={saving}>Cancelar</Button><Button onClick={() => void savePin()} loading={saving} data-testid="map-pin-save">Guardar ubicación</Button></>}>
        {pinned && (
          <div className="space-y-3 text-sm">
            <p>Se guardará como ubicación de referencia de <b>{formatClientName(pinned.client.name)}</b> el punto marcado en el mapa
              ({pinned.lat.toFixed(5)}, {pinned.lng.toFixed(5)}). Queda registrado como «punto marcado en el mapa», con su nombre y la fecha.</p>
            {pinned.client.location && <p className="text-amber-700">Sustituye a la ubicación actual ({pinned.client.location.source === 'gps_on_site' ? 'GPS en el lugar' : 'punto en el mapa'}, {formatDate(pinned.client.location.setAt)}). La anterior queda en el historial.</p>}
            <Input label="Nota (opcional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: local en la esquina, portón azul" />
            {history && history.length > 0 && (
              <div data-testid="map-location-history">
                <p className="text-xs font-semibold text-gray-600 mb-1">Historial de su ubicación ({history.length})</p>
                <ul className="text-xs text-gray-600 space-y-0.5 max-h-28 overflow-y-auto">
                  {history.map((h, i) => (
                    <li key={i}>{formatDateTime(h.setAt)} · {h.source === 'gps_on_site' ? 'GPS en el lugar' : 'punto en el mapa'}{h.accuracyM != null ? ` ±${h.accuracyM} m` : ''}{h.setByName ? ` · ${formatPersonName(h.setByName)}` : ''}{h.note ? ` · ${h.note}` : ''}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
