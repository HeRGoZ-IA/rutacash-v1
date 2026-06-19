# RutaCash V1 — Alcance Funcional

## ¿Qué incluye esta versión?

### Autenticación y roles
- [x] Login con email/password
- [x] Usuarios demo predefinidos
- [x] Roles: superadmin, admin, supervisor, cobrador
- [x] Redirección por rol
- [x] Persistencia de sesión (localStorage via Zustand)

### Super Admin Plataforma
- [x] Listado de empresas/prestamistas
- [x] Crear empresa con plan y fecha vencimiento
- [x] Activar/suspender empresa
- [x] Métricas básicas por empresa

### Oficinas
- [x] Crear, editar, activar/desactivar
- [x] Asociar a empresa
- [x] Ver métricas: rutas, clientes activos

### Rutas
- [x] Crear, editar, activar/desactivar
- [x] Asignar cobrador
- [x] Configurar tasa de interés, límite de préstamo
- [x] Registrar capital inicial

### Dashboard Admin
- [x] KPIs: capital, cartera, recaudo hoy/semana
- [x] Gráfica de recaudo 7 días
- [x] Top rutas por recaudo
- [x] Alertas: sync pendiente, rutas sin cobrador, mora

### Clientes
- [x] Crear, editar
- [x] Búsqueda por nombre/documento/teléfono
- [x] Filtros por estado y ruta
- [x] Ficha completa del cliente
- [x] Estados: activo, inactivo, moroso, perdido

### Ventas / Créditos
- [x] Crear venta con cálculo automático de interés
- [x] Generación automática de cuotas
- [x] Ver detalle con tabla de cuotas
- [x] Marcar como perdida con motivo
- [x] Filtros por ruta y búsqueda

### Motor de cuotas
- [x] Generación de cuotas (diaria, semanal, quincenal, mensual)
- [x] Aplicar pago parcial/completo/adelantado
- [x] Recalcular desde pagos
- [x] Cálculo de mora
- [x] Estado de cada cuota

### Pagos
- [x] Registro desde panel admin
- [x] Registro desde app cobrador
- [x] Pago completo, parcial, adelantado
- [x] Geolocalización opcional
- [x] Recibo WhatsApp (botón que abre wa.me)
- [x] Estado de sync: synced/pending

### No pago / Visita
- [x] Registrar motivo de no pago
- [x] Opciones: no estaba, sin dinero, negocio cerrado, promesa, otro
- [x] Fecha de promesa opcional

### Capital
- [x] Inyectar capital a rutas
- [x] Historial de movimientos
- [x] Resumen por ruta

### Gastos
- [x] Categorías predefinidas
- [x] Registrar gasto con categoría, valor, fecha
- [x] Historial por ruta

### Transferencias
- [x] Transferir entre rutas
- [x] Historial

### Retiros
- [x] Registrar retiro desde ruta
- [x] Historial y total

### Caja
- [x] Resumen completo por ruta y rango de fechas
- [x] Fórmula: saldo ant. + capital + cobros + trans.ent. - préstamos - gastos - trans.sal. - retiros
- [x] KPIs de caja

### Liquidación semanal
- [x] Por oficina, rango de fechas personalizable
- [x] Tabla por ruta con todos los movimientos
- [x] Totales generales
- [x] Exportar CSV

### Reportes
- [x] Pagos recibidos
- [x] Ventas/créditos
- [x] Gastos
- [x] Caja diaria por ruta
- [x] Exportar CSV

### Usuarios
- [x] Crear, editar, activar/desactivar
- [x] Asignar rol, oficina, ruta

### App Cobrador (móvil)
- [x] Home con saludo, stats y botón iniciar ruta
- [x] Lista de clientes con estado de pago hoy
- [x] Búsqueda rápida
- [x] Botones: Cobrar, No pagó, Ver
- [x] Pantalla de pago con montos rápidos
- [x] Registro de ubicación
- [x] No pago con motivo
- [x] Gastos del cobrador
- [x] Sincronización (simula en V1)
- [x] Navegación inferior estilo app

### Soporte offline
- [x] Detección online/offline
- [x] IndexedDB como almacenamiento principal
- [x] Pagos guardados como pending offline
- [x] Banner "Sin conexión"
- [x] Simulación de sync al reconectar

### Datos demo
- [x] 1 empresa
- [x] 2 oficinas
- [x] 4 rutas
- [x] 7 usuarios
- [x] 20 clientes
- [x] 12 ventas activas con cuotas generadas
- [x] Pagos de cuotas pasadas
- [x] Gastos, capital, transferencias, retiros
- [x] Botón "Restaurar demo" en configuración
- [x] Exportar backup JSON

### Diseño
- [x] Tailwind CSS con design system propio
- [x] Paleta: azul profundo, verde, gris, blanco
- [x] Componentes: Card, Button, Badge, Modal, Input, Toast, EmptyState
- [x] Sidebar admin (desktop/mobile)
- [x] Bottom navigation cobrador
- [x] Badges de estado con colores
- [x] Responsive

## ¿Qué queda para V2?

Ver `future-roadmap.md`

## Usuarios demo

| Email | Contraseña | Rol |
|-------|-----------|-----|
| superadmin@demo.com | 123456 | Super Admin |
| admin@demo.com | 123456 | Administrador |
| supervisor@demo.com | 123456 | Supervisor |
| cobrador@demo.com | 123456 | Cobrador |
