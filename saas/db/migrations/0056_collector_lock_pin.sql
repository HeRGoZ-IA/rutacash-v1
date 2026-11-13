-- 0056: PIN de bloqueo de la app del Cobrador (petición del socio, decisión del propietario 2026-11-13, pendiente 3.45).
--
-- A los 10 minutos sin uso, la app del Cobrador se tapa con una pantalla neutra que se abre con un PIN de 4 dígitos
-- ÚNICO por empresa (todos los Cobradores usan el mismo), que define y cambia el SuperAdmin o el Administrador desde
-- Configuración. El PIN nunca va en el código (la web es pública): se guarda aquí como derivación PBKDF2-SHA256 con sal
-- (`pbkdf2-sha256$<iteraciones>$<sal base64>$<derivación base64>`) y la app del Cobrador se copia esa derivación para
-- comprobar el PIN sin señal. NULL = todavía el valor inicial 0000 (la app avisa al Administrador para que lo cambie).
-- La escritura la cubre la política existente `companies_settings_update` (SuperAdmin y Administrador de su empresa).

alter table adex.companies add column collector_pin text;
alter table adex.companies add constraint companies_collector_pin_format
  check (collector_pin is null or collector_pin ~ '^pbkdf2-sha256\$[0-9]{4,7}\$[A-Za-z0-9+/=]{16,64}\$[A-Za-z0-9+/=]{40,64}$');

grant update (collector_pin) on adex.companies to adex_api;
