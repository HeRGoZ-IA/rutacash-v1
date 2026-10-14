# RutaCash — Roadmap Futuro

> **Documento histórico (junio de 2026).** Se conserva sin cambios como registro de ideas. **No es una hoja de ruta aprobada.** Lo encuadran el documento rector [VISION_Y_PRINCIPIOS_SAAS_ADEX.md](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) (principios P1–P10) y las [decisiones SaaS](./DECISIONES_PENDIENTES_SAAS_2026-10.md). Nota añadida el 2026-10-14.
>
> **Superado:**
> - «API REST/RPC en Edge Functions»: sustituido por DS-01 (API TypeScript propia con comandos transaccionales + PostgreSQL gestionado).
> - «Sync bidireccional (offline-first con Supabase Realtime)»: contradice P2 (PostgreSQL central como única fuente de verdad financiera). La operación sin conexión queda acotada por DS-07/DS-08.
> - «Bases de datos dedicadas por cliente» como modelo: sustituido por DS-15 (tablas compartidas + RLS + autorización en la API). La infraestructura dedicada es solo una excepción justificada.
>
> **Sin aprobar, sujeto a decisión:**
> - Supabase y Supabase Auth: candidatos validados técnicamente (Fase 0A.1), no elegidos (DS-02, DS-03). La RLS por empresa sí está aprobada (DS-15).
> - «Multi-moneda»: P6 prevé una moneda por empresa. No hay conversión entre monedas aprobada.
> - «Benchmarking entre empresas»: debe respetar el aislamiento de P1.
> - Integraciones de pago, mensajería y contabilidad: requieren decisión por país (P6).

## V2 — Backend Real (Supabase)

- [ ] Migrar de IndexedDB a Supabase/PostgreSQL
- [ ] Autenticación real con JWT (Supabase Auth)
- [ ] Row Level Security por tenant
- [ ] API REST/RPC en Edge Functions
- [ ] Sync bidireccional (offline-first con Supabase Realtime)
- [ ] Storage para fotos de clientes/documentos (Supabase Storage)
- [ ] Webhooks para eventos críticos

## V2 — App Nativa Android

- [ ] Capacitor o React Native
- [ ] Push notifications (Firebase FCM)
- [ ] GPS en segundo plano
- [ ] Cámara integrada (fotos clientes)
- [ ] Firma digital del cliente

## V2 — Comunicación

- [ ] WhatsApp Business API (Meta)
- [ ] Mensajes automáticos: recordatorio de cuota, confirmación de pago
- [ ] Plantillas personalizables por empresa
- [ ] SMS como fallback

## V3 — Monetización y SaaS

- [ ] Pasarela de pagos para suscripciones (Stripe / MercadoPago)
- [ ] Portal de auto-servicio para prestamistas
- [ ] Facturación automática mensual
- [ ] Periodo de prueba gratuito
- [ ] Onboarding asistido

## V3 — Reportes Avanzados

- [ ] PDF con logo del prestamista
- [ ] Reporte de mora detallado
- [ ] Proyección de flujo de caja
- [ ] Comparativa entre periodos
- [ ] Dashboard ejecutivo con BI

## V3 — Inteligencia de Negocio

- [ ] Scoring de clientes (histórico de pagos)
- [ ] Alertas predictivas de mora
- [ ] Recomendación de límite de crédito
- [ ] Análisis de rutas más rentables

## V4 — Enterprise

- [ ] Multi-moneda (USD, EUR, etc.)
- [ ] Marca blanca (white-label) para revendedores
- [ ] Bases de datos dedicadas por cliente (Supabase Projects)
- [ ] SLA garantizado (uptime 99.9%)
- [ ] Soporte prioritario
- [ ] Integración contable (Siigo, Alegra, QuickBooks)

## V4 — Operaciones Avanzadas

- [ ] Mapa de rutas (Google Maps / Mapbox)
- [ ] Optimización de recorrido (TSP algorithm)
- [ ] Conciliación automática de transferencias bancarias
- [ ] Integración con PSE/Bancolombia para pagos electrónicos
- [ ] Refinanciamiento de créditos
- [ ] Crédito grupal (solidarity lending)

## V5 — Ecosistema

- [ ] Marketplace de terceros (proveedores de servicios financieros)
- [ ] API pública para integraciones
- [ ] SDK para otros desarrolladores
- [ ] Portal de analytics para el super admin
- [ ] Benchmarking entre empresas (anónimo)
