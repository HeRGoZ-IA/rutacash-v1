// Inicio del contexto activo y módulos todavía no disponibles (sin fingir operaciones).

import { Link } from 'react-router-dom';
import { useCtx } from '../lib/app.tsx';
import { useRoutes } from '../lib/lookups.ts';
import { ROLE } from '../lib/format.ts';
import { Badge, Section } from '../ui.tsx';
import { navFor } from '../nav.ts';

export function Home() {
  const ctx = useCtx();
  const routes = useRoutes();
  const items = navFor(ctx).filter((n) => n.to !== '/app');
  return (
    <>
      <Section title={`${ctx.company.name}`}>
        <p>Está operando como <strong>{ROLE[ctx.role] ?? ctx.role}</strong>
          {ctx.company.isDemo ? <> · <Badge tone="info">Empresa Demo: todos los datos son ficticios</Badge></> : null}</p>
        <p className="muted small">País {ctx.company.countryCode} · moneda {ctx.company.currencyCode} · zona horaria {ctx.company.timezone}</p>
        <p className="muted small">Rutas: {ctx.role === 'superadmin' ? 'todas las de la empresa' : (routes.data ?? []).map((r) => r.name).join(', ') || 'ninguna asignada'}</p>
      </Section>
      <div className="tiles">
        {items.map((n) => (
          <Link key={n.to} to={n.to} className="tile"><strong>{n.label}</strong><span className="muted small">{n.hint}</span></Link>
        ))}
      </div>
    </>
  );
}

const UPCOMING = [
  ['Visitas sin pago', 'Registro de visitas y promesas de pago'],
  ['Reportes', 'Reportes completos de cartera y caja'],
];

export function Upcoming() {
  return (
    <Section title="Próximamente">
      <p className="muted">Estos módulos todavía no existen en el servidor de ADEX Online. No se pueden registrar ni simular desde aquí.</p>
      <ul className="list">
        {UPCOMING.map(([name, hint]) => (
          <li key={name}><div className="row-static disabled"><strong>{name}</strong><span className="muted small">{hint}</span><Badge>No disponible en esta versión</Badge></div></li>
        ))}
      </ul>
    </Section>
  );
}
