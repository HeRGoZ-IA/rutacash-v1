# RutaCash V1 — Restablecer app limpia (reset local del navegador)

**Fecha:** 2026-06-23
**Ruta del proyecto:** `C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash`
**Objetivo:** Botón seguro para dejar la app **CLEAN** completamente limpia en el navegador actual,
borrando todos los datos locales que RutaCash controla.

> Sin backend/Supabase, sin commit/push/deploy, sin tocar GitHub/Vercel. No rompe DEMO ni CLEAN.
> No se ejecuta limpieza automática al abrir la app; siempre requiere confirmación.

---

## 1. Archivos modificados / creados
| Archivo | Cambio |
|---|---|
| `src/lib/resetApp.ts` | **Nuevo.** Helper `resetLocalAppData()` que limpia todos los datos locales. |
| `src/pages/admin/SettingsPage.tsx` | Tarjeta **“Restablecer app limpia”** (CLEAN) con confirmación fuerte; el reset de DEMO (“Restaurar datos demo”) también usa el helper robusto. |
| `src/components/ui/AppModeBanner.tsx` | Banner DEMO usa el reset robusto; banner CLEAN ahora incluye acceso **“Restablecer app limpia”**. |

## 2. Qué borra el botón (`resetLocalAppData`)
Todo lo que RutaCash controla en **este navegador/dominio**:
- **IndexedDB / Dexie**: `db.delete()` (base completa de RutaCash).
- **localStorage** y **sessionStorage**: solo claves con prefijo **`rutacash-`** (p. ej.
  `rutacash-auth`, `rutacash-collector-route`, `rutacash-office-filter`). **No** toca claves de
  otros sistemas.
- **Cache Storage** del dominio: `caches.delete(...)` de todas las cachés.
- **Service Workers** registrados en el dominio: `unregister()`.
- **Sesión actual**: al borrar `rutacash-auth` y recargar, queda deslogueado en `/login`.

Cada paso está envuelto en `try/catch` para no dejar la pantalla rota; al terminar se hace una
**recarga dura** a `/login` (`location.replace`).

## 3. Qué conserva / vuelve a sembrar
Tras el borrado + recarga, la semilla del **modo actual** se reinicializa:
- **CLEAN** (`seedCleanDatabase`): crea solo lo mínimo → **administrador inicial**
  (`admin@demo.com` / `123456`), **tenant base** y **categorías de gasto predeterminadas**.
  **Sin** rutas, clientes, ventas, abonos ni gastos operativos.
- **DEMO** (`seedDatabase`): recarga los **datos de demostración** (no deja la app vacía).

## 4. Diferencia DEMO vs CLEAN
| | DEMO | CLEAN |
|---|---|---|
| Botón | “Restaurar datos demo” | “Restablecer app limpia” |
| Resultado | Vuelve a cargar datos ficticios | Deja la app vacía lista para empezar |
| Ubicación | Banner superior + Configuración | Banner superior + Configuración (zona roja) |
No se mezclan datos: el re-sembrado depende del **modo de build** (`VITE_APP_MODE`), no del botón.

## 5. UX de seguridad
- **Confirmación fuerte** antes de borrar (modal en Configuración; `confirm` en el banner).
- Texto claro de que es **local a este navegador** y **no se puede deshacer**.
- Botón con estado de carga + `disabled` para **evitar doble clic**.
- Mensaje de éxito breve antes de recargar.

## 6. Limitación
**No** borra el caché global del navegador ni datos de otros sitios: solo lo que RutaCash controla
dentro de su dominio (IndexedDB, storage `rutacash-*`, Cache Storage y Service Workers del dominio).

## 7. Cómo probar
1. `npm run dev:clean`.
2. Crear ruta, cobrador, cliente, venta y abono.
3. **Configuración → “Restablecer app limpia”** (o el banner superior) → confirmar.
4. La app borra los datos locales y **recarga en `/login`**.
5. Entrar con `admin@demo.com` / `123456`.
6. Verificar: **sin** rutas/clientes/ventas/abonos previos; **no** aparecen datos demo; checklist
   limpio inicia desde cero (Empresa → Rutas → Clientes → Ventas → Parcelas/Abonos; ya no pide oficina).
7. `npm run dev:demo` sigue funcionando y “Restaurar datos demo” recarga los datos ficticios.

## 8. Riesgos detectados
1. **Acción irreversible** local: por eso requiere confirmación explícita. No afecta otros equipos.
2. **Service Worker/Cache**: si en el futuro se añade PWA, el reset ya los contempla; hoy
   normalmente no hay SW registrado (no-op seguro).
3. **Recarga dura** a `/login`: si el hosting no tuviera fallback SPA, podría fallar; en dev y en
   Vercel (con `vercel.json`) el fallback existe.

## 9. Qué NO se cambió
- Lógica de negocio (rutas, clientes, ventas, parcelas, abonos, caja, liquidación).
- Semillas DEMO/CLEAN (solo se invocan vía recarga; no se modificó su contenido).
- No se ejecuta limpieza automática en el arranque.

## 10. Build — ✅ OK
```
npm run build   # tsc && vite build → sin errores de TypeScript
```
