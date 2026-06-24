# PROMPT.md — RutaCash

## 1. Identidad del proyecto

* Nombre formal: RutaCash
* Nombre corto: RutaCash (ex-CobrosApp)
* Tipo: PRODUCTO_COMERCIAL / APP_WEB
* Área HRWorkSpace: 01_PRODUCTOS_COMERCIALES
* Estado actual: ACTIVO

## 2. Ruta actual

```text
C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash
```

## 3. Propósito

**Sistema de gestión de cobro diario ("cobradiario") y préstamos** (evolución de CobrosApp).
Producto con potencial comercial. Es una app **local-first**: funciona en el navegador con base de
datos local, sin backend externo.

## 4. Estado actual

* Estado: **ACTIVO**
* Última situación conocida: Migrado a HRWorkSpace; tiene auditoría interna (`AUDITORIA_RUTACASH_V1_SOCIO.md`).
* Qué sí funciona: Proyecto Vite con estructura completa (`src/`, `public/`, configs).
* Qué no debe asumirse: No asumir que está desplegado. `.env.clean` y `.env.demo` corresponden a
  **modos de Vite** (`--mode demo` / `--mode clean`), no a secretos de producción.

## 5. Stack / tecnología

* Lenguaje: TypeScript
* Framework: Vite 8 + React 18 (TSX), Tailwind CSS 3
* Servicios externos: Ninguno requerido (app local-first); despliegue vía Vercel (`vercel.json`)
* Base de datos: **Dexie (IndexedDB)** — base de datos local en el navegador
* Otros: estado con `zustand`, ruteo `react-router-dom`, gráficas `recharts`, validación `zod`, `date-fns`, `uuid`; `tsconfig.json`, `postcss.config.js`, repo git propio (`.git/`)

## 6. Estructura importante

* `src/` — código fuente
* `public/` — estáticos
* `docs/` — documentación
* `index.html`, `vite.config.ts`, `tailwind.config.js`, `vercel.json`
* `AUDITORIA_RUTACASH_V1_SOCIO.md`, `README_MIGRACION_RUTACASH.md`
* `.env.clean`, `.env.demo` — configuración (ver sección 9)

## 7. Comandos permitidos

* Revisar código y documentación (solo lectura).
* Revisar `package.json` para entender scripts.
* No ejecutar sin revisión previa.

## 8. Comandos prohibidos o peligrosos

* `npm install`
* `npm run dev`
* `npm run build`
* deploy (Vercel)
* git push
* scripts que conecten a APIs/servicios externos

* Detectados por nombre: `.env.clean`, `.env.demo`. Son **archivos de modo de Vite** (los scripts
  `dev:demo`/`dev:clean`/`build:*` los usan), no secretos de producción. Aun así, no revelar su contenido.
* Al ser local-first (Dexie/IndexedDB), no maneja claves de servicios externos.
* No subir `.env*` a Git; revisar `.gitignore` (existe).
* No compartir por chat.

## 10. Flujo de trabajo con IA

* Leer este PROMPT.md primero.
* Revisar `AUDITORIA_RUTACASH_V1_SOCIO.md` y `README_MIGRACION_RUTACASH.md`.
* No ejecutar comandos sin permiso.
* Antes de modificar, hacer un plan.
* Después de cambios grandes, actualizar el changelog.

## 11. Pendientes actuales

* Confirmar estado de despliegue en Vercel.
* Definir estrategia de respaldo de datos (al ser local en IndexedDB, los datos viven en el navegador del usuario).

## 12. Decisiones tomadas

* Renombrado/reposicionado desde CobrosApp a RutaCash como producto comercial.
* Arquitectura **local-first** con Dexie/IndexedDB; sin backend externo.

## 13. Changelog

### 2026-06-20 — Creación de PROMPT.md estándar

* Se creó este archivo como contexto oficial para trabajar el proyecto con IA.
* El proyecto forma parte de HRWorkSpace.
* Se documentó estado inicial, rutas, riesgos y pendientes.

### 2026-06-21 — Resolución de pendientes (revisión solo lectura)

* Confirmado propósito (cobro diario y préstamos) y stack: React 18 + TS + Vite + Tailwind + Dexie/IndexedDB + zustand.
* Confirmado: BD local (sin backend), y `.env.clean`/`.env.demo` son modos de Vite, no secretos. No se modificó nada interno.
