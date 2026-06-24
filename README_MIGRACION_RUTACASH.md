# RutaCash (CobrosApp) — Nota de Migración

## Fecha de migración

2026-06-20

## Origen y destino

| | Ruta |
|---|---|
| **Origen** | `C:\TradingBot\CobrosApp` |
| **Destino** | `C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash` |

## ¿Qué es este proyecto?

**RutaCash** (repositorio: `rutacash-v1`) es una aplicación web de gestión de cobros.

Stack: **React + Vite + Tailwind CSS** con modo offline/online, roles admin/cobrador, rutas, clientes, caja, informes y sincronización.

Referencia para entender el producto: ver `AUDITORIA_RUTACASH_V1_SOCIO.md` (27KB).

---

## Qué se copió y qué se excluyó

**Incluido en la migración:**

- `src/` — todo el código fuente React/TypeScript
- `public/` — assets públicos
- `docs/` — documentación del proyecto
- `.git/` — repositorio Git completo (rama main, remote GitHub)
- `package.json` + `package-lock.json` — definición de dependencias
- `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`, `tsconfig.node.json`
- `index.html`
- `vercel.json` — configuración de deploy en Vercel
- `.env.demo` + `.env.clean` — plantillas de variables de entorno (sin credenciales reales)
- `AUDITORIA_RUTACASH_V1_SOCIO.md`
- `.claude/settings.json`

**Excluido (regenerable / basura):**

| Excluido | Por qué |
|---|---|
| `node_modules/` | Regenerable con `npm install` |
| `dist/` | Regenerable con `npm run build` |

---

## Estado git al migrar

| Dato | Valor |
|---|---|
| Rama activa | `main` |
| Remote | `https://github.com/HeRGoZ-IA/rutacash-v1.git` |
| Cambios sin commit | 1 archivo sin trackear: `AUDITORIA_RUTACASH_V1_SOCIO.md` |

El archivo `AUDITORIA_RUTACASH_V1_SOCIO.md` aparecía como `??` (untracked) en git status al momento de la migración. No se ejecutó ningún commit ni push.

---

## Archivos .env detectados (solo nombres, sin contenido)

| Archivo | Descripción |
|---|---|
| `.env.demo` | Plantilla de demo (no credenciales reales) |
| `.env.clean` | Plantilla vacía (para setup inicial) |
| `.env` | **No existe** en el proyecto |
| `.env.local` | **No existe** en el proyecto |

Para ejecutar en entorno real se necesita crear un `.env.local` con las variables de conexión.

---

## Cómo instalar dependencias (cuando se vaya a probar)

```bash
cd C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash
npm install
```

## Cómo ejecutar en modo desarrollo

```bash
npm run dev
```

El servidor estará disponible en `http://localhost:5173` (o el puerto configurado en vite.config.ts).

---

## Advertencias

1. **Revisar `.env.local` o crear uno antes de ejecutar.** Las plantillas `.env.demo` y `.env.clean` no tienen credenciales reales.
2. **No se modificó ningún archivo de código ni de configuración durante la migración.**
3. **No se ejecutó npm, no se hizo deploy, no se inició ningún servidor.**
4. **Este proyecto tiene `.git/` activo** — el historial de commits se preservó. Conecta con el remote en GitHub (`rutacash-v1`).

---

## Clasificación en el workspace

RutaCash es un **producto comercial** y debe permanecer en:

```
C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash\
```

---

*Migrado el 2026-06-20. No se ejecutó código. No se reveló contenido de .env.*
