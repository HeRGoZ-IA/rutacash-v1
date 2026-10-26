# ADEX — Propuesta de respaldos recurrentes y recuperación (P-05)

| | |
|---|---|
| Fecha | 2026-10-26 (Ronda 76) |
| Naturaleza | Propuesta del 2026-10-26. **Alternativa A aprobada el mismo día** (RS-1 OneDrive, RS-2 clave de recuperación en el gestor de contraseñas del propietario, RS-3 copia inmediata) e implementada: ver §8. No se contrató nada ni se activó PITR; las copias anteriores se conservan |
| Pendiente que atiende | P-05 / DS-02 / DS-14 (listado consolidado §2.3.1) |
| Decisiones requeridas | §7 (RS-1…RS-3 aprobadas; RS-4 y RS-5 abiertas) |

Los objetivos de RPO y RTO de este documento son **propuestos**, no capacidades demostradas. Lo único demostrado hasta hoy es la restauración aislada de copias puntuales (R73 §8.1, R74 §16.3).

## 1. Lo que existe hoy (comprobado el 2026-10-26)

| Punto | Situación |
|---|---|
| Copias | Cuatro volcados lógicos cifrados en `C:\Users\Usuario\ADEX-respaldos`: `adex-20261023T1143`, `adex-20261023T1820`, `adex-20261024T1408`, `adex-20261024T1551` (~1,1 MB cada uno). Cada copia tiene tres archivos: `.dump.enc` (volcado), `.key.dpapi` (clave) y `.json` (metadatos y huella) |
| Método | `pg_dump` 17 en formato personalizado de los esquemas `adex`, `adex_control`, `adex_demo`, `adex_meta`, `auth` y `public`. Es una lectura que no modifica la base gestionada |
| Cifrado | AES-256-GCM. La clave está protegida con **DPAPI del usuario de Windows** («CurrentUser»): solo se descifra con ese usuario en ese equipo |
| Verificación | `adex-20261024T1408` y `adex-20261024T1551` se restauraron en un PostgreSQL local aislado: 82 tablas y 2.233 filas idénticas, 0 diferencias (`tmp/r74pub/restore-check*.log`) |
| Copias posteriores a la activación de Base por Ruta | **No hay.** La última es de las 15:51 UTC del 2026-10-24, antes de activar BlueLine. Todo lo operado desde entonces (activación, reparto de R$ 123,00 y la operación diaria) **no tiene copia** |
| Script | Lo ejecutaron las sesiones de R73 y R74. **No está versionado ni guardado** junto a las copias, así que hoy no hay un procedimiento repetible |
| Frecuencia | Manual, solo antes de migrar |
| Plan del proveedor | Según R73 §7.4, el proyecto «ADEX-Staging» está en el **plan Free** de Supabase, que no tiene copias automáticas. No se pudo volver a verificar: no hay token de la Management API, a propósito |

### Qué cubren las copias y qué no

| Componente | ¿En la copia? | Cómo se recupera hoy |
|---|---|---|
| Datos financieros y operativos (`adex*`) | Sí | Restaurar el volcado |
| Usuarios y sesiones de Supabase Auth (`auth`) | Sí, sus tablas | Restaurar el volcado |
| Configuración de Auth (URL de redirección, plantillas, SMTP), claves JWT y claves de la API | **No** | Volver a configurarlas en el proyecto nuevo y actualizar las variables de Render y Vercel |
| Contraseñas de los roles `adex_api`, `adex_control` y `adex_demo` | **No** (Supabase tampoco las guarda en sus copias) | `npm run staging:migrate` las vuelve a aplicar desde `saas/.env.online` |
| Storage y Vault | Vacíos en R73. ADEX no guarda archivos | — |
| Variables de entorno de Render (2 servicios) y Vercel | **No** | Hoy solo están en los paneles y en `saas/.env.*` locales |
| Código | Sí, en GitHub (`HeRGoZ-IA/rutacash-v1`) | — |

### Riesgos actuales

1. **Un único lugar.** Las copias, la clave y el equipo son la misma cosa: si el disco falla, se pierde el equipo o se reinstala Windows, se pierden todas las copias **y** la clave para leerlas.
2. **Sin copia desde la activación:** hoy el RPO real es de más de 2 días y crece cada día.
3. Sin script versionado, repetir la copia depende de reconstruir el procedimiento.
4. Nadie avisa si no se hace la copia.

## 2. Alternativas comparadas

Precios verificados el 2026-10-26 en la documentación oficial ([copias de Supabase](https://supabase.com/docs/guides/platform/backups), [precios de Supabase](https://supabase.com/pricing), [cómputo de Supabase](https://supabase.com/docs/guides/platform/compute-and-disk), [precios de Cloudflare R2](https://developers.cloudflare.com/r2/pricing)).

| | **A. Automatizar la copia lógica cifrada actual** | **B1. Supabase Pro (copias diarias)** | **B2. Supabase Pro + PITR** |
|---|---|---|---|
| Qué es | El mismo volcado cifrado, ejecutado a diario por el Programador de tareas de Windows, con copia independiente y ensayo de restauración | Copias diarias gestionadas por Supabase, con retención de 7 días | Recuperación a cualquier segundo; los WAL se guardan cada 2 minutos |
| Costo mensual | **US$ 0** (destino: carpeta de OneDrive o disco USB; R2 tiene 10 GB-mes gratis y una copia pesa ~1 MB) | **US$ 25** (incluye US$ 10 de cómputo, que cubren una instancia Micro) | **≈ US$ 130**: Pro 25 + subir a cómputo Small, que PITR exige (~US$ 15 frente a los 10 incluidos: +~5) + PITR de 7 días (~US$ 100). Con 14 días ~US$ 230; con 28 días ~US$ 430 |
| RPO (cuánto se puede perder) | ≤ 24 h, solo si el equipo está encendido a la hora programada | ≤ 24 h | ≤ 2 minutos (peor caso según Supabase) |
| Independencia del proveedor | **Sí**: la copia queda fuera de Supabase | No: la copia vive dentro de Supabase. Si se pierde la cuenta o el proyecto, se pierde la copia | No (igual que B1) |
| Restauración | En una base aislada o en un proyecto nuevo. El proyecto actual no se toca | Sobre el proyecto, que queda **inaccesible** durante la restauración. No restaura los objetos de Storage ni las contraseñas de los roles | Igual que B1, a un instante exacto. **Al activar PITR se detienen las copias diarias** |
| Dependencia | El equipo del propietario y su usuario de Windows | La cuenta de Supabase y su facturación | Ídem |
| Limitación | La copia no se hace con el equipo apagado | No tiene copia fuera del proveedor; con 7 días de retención, un error que se descubra tarde ya no se puede recuperar | Costo alto para el volumen actual (2.233 filas) |

Las opciones no se excluyen: B no sustituye a A. Solo A deja una copia **fuera** del proveedor.

## 3. Recomendación para el prelanzamiento: A, completada

Costo: **US$ 0**.

| Elemento | Propuesta |
|---|---|
| Frecuencia | Una copia **diaria** a las 23:30 hora de Brasil, después del cierre habitual. Además, una copia **obligatoria antes de cada migración** (ya es la regla) |
| Retención | Las 14 diarias más recientes, una semanal durante 8 semanas, una mensual durante 12 meses y las de antes de cada migración durante 12 meses. Con ~1 MB por copia el espacio es despreciable |
| Destino independiente | Copia 1 en `C:\Users\Usuario\ADEX-respaldos`, como hoy. Copia 2 en un destino **fuera del equipo**: la carpeta de OneDrive personal del propietario (recomendado, sin costo nuevo) o un disco USB que se rota cada semana. Nada en el repositorio |
| Cifrado y clave | AES-256-GCM como hoy. La clave de cada copia se protege **dos veces**: con DPAPI (uso diario) y con una **clave de recuperación** que el propietario guarda en su gestor de contraseñas o impresa en un sobre. Sin la clave de recuperación, una copia fuera del equipo no sirve si el equipo se pierde. Nunca se escribe en el chat, en el repositorio ni en los registros |
| Script | Se versiona en `saas/scripts/backup/`: volcado, cifrado, huella, copia al segundo destino, poda por retención y ensayo de restauración. Lee las credenciales de `saas/.env.staging` sin mostrarlas |
| Aviso de fallos | El Programador de tareas registra cada ejecución. Si falla o no hubo copia en 36 h, aviso por notificación de Windows y una línea en `ADEX-respaldos\estado.json`. Opcional: correo con el SMTP que se decida en 2.3.4 |
| Ensayo de restauración | **Semanal y automático** (en PostgreSQL local aislado, sin tocar la base gestionada): restaura la copia más reciente y compara el recuento de filas por tabla y los saldos con una foto de solo lectura. **Mensual y manual**: el propietario ensaya la recuperación completa en un proyecto Supabase nuevo y vacío, siguiendo §5 |
| RPO objetivo | 24 h (propuesto) |
| RTO objetivo | 4 h para tener la API sirviendo desde un proyecto nuevo (propuesto; se medirá en el primer ensayo mensual) |
| Responsables | Propietario: guarda la clave de recuperación, aprueba los destinos y ejecuta la recuperación real. Claude Code: mantiene el script, revisa los resultados del ensayo semanal y prepara los pasos de recuperación |

**Primer paso urgente**, sea cual sea la decisión: hacer **ahora** una copia cifrada nueva, porque no existe ninguna posterior a la activación de Base por Ruta.

## 4. Qué cambia antes de incorporar empresas comerciales

1. **Supabase Pro (B1, US$ 25 al mes)** además de A. Da copias gestionadas, sin pausas por inactividad y con soporte del proveedor. El proyecto debe quedar en una organización de ADEX o, si se usa la organización Pro de STARCLI, como proyecto propio de ADEX, **sin compartir proyecto, esquemas ni secretos** con Starcli Loyalty.
2. **PITR (B2)** cuando el volumen diario de dinero lo justifique o los contratos lo exijan (RPO de minutos). Hoy no lo justifica.
3. Renombrar o recrear el proyecto: hoy se llama «ADEX-Staging» y aloja una empresa real (2.3.2).
4. RPO y RTO **escritos en el contrato** con las empresas, una vez medidos en los ensayos.
5. Copia de la configuración: inventario versionado, **sin valores**, de las variables de Render, de Vercel y de la configuración de Auth.
6. Mover la copia automática del equipo del propietario a un servidor que no se apague, por ejemplo una tarea programada en la nube con destino R2. Exige guardar credenciales de la base en otro servicio, una dependencia nueva que **requiere autorización**.

## 5. Procedimiento de recuperación (borrador, se valida en el primer ensayo mensual)

1. **Decidir** (propietario): qué falló, desde qué instante y qué copia usar (la última verificada anterior al incidente).
2. Crear un proyecto Supabase **nuevo** (nunca restaurar encima de BlueLine sin decisión expresa) en la misma región `sa-east-1`.
3. Descifrar la copia (DPAPI o clave de recuperación) y comprobar la huella SHA-256 del `.json`.
4. `pg_restore` en el proyecto nuevo, que incluye `auth`.
5. `npm run staging:migrate` con la referencia nueva. Vuelve a crear las contraseñas de los roles y comprueba la huella de las migraciones.
6. Configurar Auth (URL, SMTP) y las claves en Render (`adex-online-api` y `adex-owner-api`) y en Vercel. Desplegar a mano.
7. Verificar en solo lectura: `/healthz`, conciliación de 26 comprobaciones, recuentos y saldos frente a la última foto.
8. Avisar a las empresas de qué ventana de datos hay que volver a registrar (lo posterior a la copia).

## 6. Lo que no hace esta propuesta

No contrata planes, no activa PITR, no crea cuentas en servicios nuevos (R2, OneDrive no se configuró), no sustituye ni borra las copias actuales y no copia datos reales a ningún sitio nuevo.

## 7. Decisiones que faltan (propietario)

| # | Decisión | Recomendación |
|---|---|---|
| RS-1 | Aprobar la alternativa A con el segundo destino. ¿OneDrive personal o disco USB? | A con OneDrive |
| RS-2 | Aprobar la clave de recuperación y dónde se guarda (gestor de contraseñas o sobre impreso) | Gestor de contraseñas |
| RS-3 | Autorizar la copia nueva inmediata (no hay ninguna posterior a la activación) | Sí, ya |
| RS-4 | Supabase Pro antes de la primera empresa comercial, y en qué organización | Sí, en una organización o proyecto propio de ADEX |
| RS-5 | PITR: no por ahora; volver a evaluarlo con la primera empresa comercial | No por ahora |

## 8. Implementación de la alternativa A (2026-10-26)

| Elemento | Estado |
|---|---|
| Script versionado | `saas/scripts/backup/adex-backup.mjs` (`npm run backup -- <orden>` desde `saas`). Sucede a `~/ADEX-tools/respaldo-r73.mjs`, que se conserva |
| Copia inmediata (RS-3) | **`adex-20261026T1535`**: 90 tablas y 2.458 filas, descifrado comprobado, copiada a OneDrive (`%OneDrive%\ADEX-respaldos`) |
| Coherencia | Los recuentos por tabla y el volcado salen de la **misma instantánea** de solo lectura (`pg_export_snapshot` + `pg_dump --snapshot`) |
| TLS | Verificado con el certificado raíz de Supabase (`ADEX_PG_SSL_CA`, `verify-full`) |
| Ensayo de restauración | `verificar` sobre `adex-20261026T1535`: restauración en PostgreSQL local aislado con **90 tablas, 0 diferencias, 0 errores inesperados** y migraciones hasta 0038 |
| Segundo destino (RS-1) | OneDrive recibe `.dump.enc`, `.key.rec` y `.json`. **Nunca** `.key.dpapi` ni datos en claro |
| Clave de recuperación (RS-2) | Orden `clave-recuperacion`. **Creada y comprobada por el propietario el 2026-10-26** (`comprobar-clave` → «CORRECTA»; guardada en Bitwarden y en su libreta). La orden genera la clave, la muestra una sola vez para su gestor de contraseñas y la aplica también a las cinco copias anteriores, sin modificarlas (solo añade `.key.rec`) |
| Recuperación sin este equipo | `recuperar --copia … [--carpeta …]` pide la clave sin mostrarla y comprueba la huella. Autoprueba con claves sintéticas (`prueba-recuperacion`): ida y vuelta correcta y clave equivocada rechazada |
| Retención | Implementada (`podar`, automática tras cada copia): 14 diarias, 1 semanal durante 8 semanas, 1 mensual durante 12 meses y las de antes de cada migración durante 12 meses. Solo afecta a copias R76; lo podado va a la Papelera. Probado con 135 copias sintéticas en una carpeta temporal: quedan 29, incluida la copia antigua |
| Automatización | `saas/scripts/backup/registrar-tareas.ps1` crea tres tareas en `\ADEX\`: copia diaria a las 21:30 (hora de Colombia, 23:30 en Brasil), ensayo los lunes a las 10:00 y vigilancia al iniciar sesión y a las 12:00. **Registradas por el propietario el 2026-10-26** (el permiso automático no permitió que las creara Claude). Primera copia automática: 2026-10-26 21:30 |
| Avisos | Notificación de Windows si falla una copia o un ensayo, si no hay una copia correcta en 36 h o si falta la clave de recuperación. Además, `ADEX-respaldos\estado.json` y `registro.log` |
| Limitación | Las tareas solo corren con la sesión de Windows iniciada. Si el equipo estuvo apagado, se ejecutan al encenderlo. RPO real: 24 h o el tiempo que el equipo pase apagado |

### Acciones del propietario (una vez, en PowerShell, desde `RutaCash\saas`)

1. `npm run backup -- clave-recuperacion`: guardar la clave que muestra en **Bitwarden** (nota segura «ADEX respaldos - clave de recuperación») **y en la libreta de la caja fuerte** del propietario (decidido el 2026-10-26).
2. `npm run backup -- comprobar-clave`: escribir la clave leyéndola de lo anotado. Debe responder «CORRECTA». No escribe ni guarda nada.
3. `powershell -ExecutionPolicy Bypass -File scripts\backup\registrar-tareas.ps1`: registra las tres tareas.
