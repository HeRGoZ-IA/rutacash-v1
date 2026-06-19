# Database Schema — RutaCash (Futura migración Supabase/PostgreSQL)

## Tablas principales

### tenants
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | Identificador único |
| nombre | TEXT NOT NULL | Nombre comercial |
| nombre_legal | TEXT | Nombre legal/razón social |
| email | TEXT UNIQUE NOT NULL | Email principal |
| telefono | TEXT | Teléfono de contacto |
| plan | ENUM('basico','operativo','profesional','empresarial') | Plan contratado |
| status | ENUM('activa','suspendida','prueba') | Estado actual |
| fecha_vencimiento | DATE | Fecha de vencimiento del plan |
| pais | TEXT | País |
| moneda | TEXT DEFAULT 'COP' | Moneda de operación |
| created_at | TIMESTAMPTZ | Creación |
| updated_at | TIMESTAMPTZ | Última actualización |

### offices
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | Empresa dueña |
| nombre | TEXT NOT NULL | |
| pais | TEXT | |
| ciudad | TEXT NOT NULL | |
| responsable | TEXT | Nombre del responsable/socio |
| telefono | TEXT | |
| email | TEXT | |
| status | ENUM('activa','inactiva') | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### routes
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| nombre | TEXT NOT NULL | |
| codigo | TEXT | Código interno |
| ciudad | TEXT | |
| tasa_interes | NUMERIC(5,2) | Porcentaje de interés |
| tasa_libre | BOOLEAN DEFAULT FALSE | Si el cobrador puede variar tasa |
| monto_maximo_prestamo | NUMERIC(15,2) | |
| capital_inicial | NUMERIC(15,2) | |
| capital_actual | NUMERIC(15,2) | |
| cobrador_id | UUID FK(users) NULL | |
| status | ENUM('activa','inactiva') | |

### users
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | NULL para superadmin |
| office_id | UUID FK(offices) NULL | |
| route_id | UUID FK(routes) NULL | |
| nombre | TEXT NOT NULL | |
| email | TEXT UNIQUE NOT NULL | |
| password_hash | TEXT NOT NULL | Hash bcrypt, NUNCA plano |
| rol | ENUM('superadmin','admin','supervisor','cobrador','socio') | |
| telefono | TEXT | |
| status | ENUM('activo','inactivo') | |

### clients
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_id | UUID FK(routes) | |
| nombre | TEXT NOT NULL | |
| documento | TEXT NOT NULL | Cédula/NIT |
| telefono_principal | TEXT NOT NULL | |
| telefono_secundario | TEXT | |
| direccion_principal | TEXT | |
| direccion_secundaria | TEXT | |
| negocio | TEXT | |
| foto_documento_url | TEXT | URL en storage |
| foto_negocio_url | TEXT | URL en storage |
| status | ENUM('activo','inactivo','moroso','perdido') | |
| notas | TEXT | |

### sales (créditos/préstamos)
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_id | UUID FK(routes) | |
| client_id | UUID FK(clients) | |
| created_by_user_id | UUID FK(users) | |
| valor_venta | NUMERIC(15,2) | Monto prestado |
| tasa_interes | NUMERIC(5,2) | % de interés |
| valor_interes | NUMERIC(15,2) | Interés calculado |
| valor_total | NUMERIC(15,2) | Total a pagar |
| saldo | NUMERIC(15,2) | Saldo pendiente |
| numero_cuotas | INTEGER | |
| valor_cuota | NUMERIC(15,2) | |
| frecuencia_pago | ENUM('diaria','semanal','quincenal','mensual','personalizada') | |
| fecha_inicio | DATE | |
| fecha_final_estimada | DATE | |
| status | ENUM('activa','finalizada','perdida','refinanciada') | |
| motivo_perdida | TEXT NULL | |

### installments (cuotas/parcelas)
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| sale_id | UUID FK(sales) | |
| numero | INTEGER | Número de cuota |
| fecha_vencimiento | DATE | |
| valor | NUMERIC(15,2) | |
| pagado | NUMERIC(15,2) DEFAULT 0 | |
| saldo | NUMERIC(15,2) | |
| status | ENUM('pendiente','parcial','pagada','vencida','adelantada') | |
| dias_mora | INTEGER DEFAULT 0 | |

### payments
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| sale_id | UUID FK(sales) | |
| client_id | UUID FK(clients) | |
| route_id | UUID FK(routes) | |
| collector_id | UUID FK(users) | |
| valor | NUMERIC(15,2) NOT NULL | |
| fecha | DATE NOT NULL | |
| tipo | ENUM('efectivo','transferencia','otro') | |
| observacion | TEXT | |
| lat | NUMERIC(10,6) | |
| lng | NUMERIC(10,6) | |
| sync_status | ENUM('synced','pending','error') | |

### expenses
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_id | UUID FK(routes) | |
| category_id | UUID FK(expense_categories) | |
| valor | NUMERIC(15,2) NOT NULL | |
| descripcion | TEXT | |
| fecha | DATE NOT NULL | |
| user_id | UUID FK(users) | |

### expense_categories
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| nombre | TEXT NOT NULL | |
| icono | TEXT | |
| activa | BOOLEAN DEFAULT TRUE | |

### capital_movements
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_id | UUID FK(routes) | |
| tipo | ENUM('ingresoCapital','ajusteCapital') | |
| valor | NUMERIC(15,2) NOT NULL | |
| descripcion | TEXT | |
| fecha | DATE NOT NULL | |
| user_id | UUID FK(users) | |

### transfers
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_origen_id | UUID FK(routes) | |
| route_destino_id | UUID FK(routes) NULL | |
| socio_destino_id | UUID FK(users) NULL | |
| valor | NUMERIC(15,2) NOT NULL | |
| descripcion | TEXT | |
| fecha | DATE NOT NULL | |
| user_id | UUID FK(users) | |

### withdrawals
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| office_id | UUID FK(offices) | |
| route_id | UUID FK(routes) | |
| valor | NUMERIC(15,2) NOT NULL | |
| descripcion | TEXT | |
| fecha | DATE NOT NULL | |
| user_id | UUID FK(users) | |

### audit_logs
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | |
| tenant_id | UUID FK(tenants) | |
| user_id | UUID FK(users) | |
| action | TEXT NOT NULL | Tipo de acción (CREATE_SALE, etc.) |
| entity_type | TEXT NOT NULL | Entidad afectada |
| entity_id | UUID | ID de la entidad |
| descripcion | TEXT | |
| metadata | JSONB | Datos adicionales |
| created_at | TIMESTAMPTZ | |

## Índices recomendados

```sql
CREATE INDEX idx_sales_tenant_status ON sales(tenant_id, status);
CREATE INDEX idx_sales_route ON sales(route_id, status);
CREATE INDEX idx_payments_route_date ON payments(route_id, fecha);
CREATE INDEX idx_installments_sale ON installments(sale_id, status);
CREATE INDEX idx_clients_tenant_route ON clients(tenant_id, route_id, status);
CREATE INDEX idx_expenses_route_date ON expenses(route_id, fecha);
```

## Row Level Security (RLS) en Supabase

Cada tabla con `tenant_id` debe tener RLS que filtre por el tenant del JWT:
```sql
CREATE POLICY tenant_isolation ON sales
  USING (tenant_id = auth.jwt() ->> 'tenant_id');
```
