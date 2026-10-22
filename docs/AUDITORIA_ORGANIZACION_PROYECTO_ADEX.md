# ADEX — Auditoría de organización del proyecto y plan de reorganización (Ronda 71)

| | |
|---|---|
| Fecha | 2026-10-22 |
| Base | `main` @ `4122e53` (igual a `origin/main` al iniciar) |
| Carácter | **Diagnóstico y plan.** En esta ronda no se borró, movió ni renombró nada; no hubo cambios de código, migraciones, bases de datos, variables ni despliegues |
| Alcance | Carpeta `RutaCash/` completa: archivos versionados, sin seguimiento e ignorados (incluidos `node_modules/`, `dist/`, `tmp/`) |
| Fuentes | `git ls-files` / `git status --ignored`, recorrido del sistema de archivos, `package.json` y `vercel.json` de raíz y de `online/`, `deploy/`, `saas/scripts/`, referencias en `docs/` y [Registro maestro](./REGISTRO_MAESTRO_EVOLUCION_ADEX.md) |
| Secretos | No se abrió ni se copia aquí el contenido de ningún `.env`, certificado ni credencial. Solo se citan sus rutas |

Clasificación usada: **A** operativo · **B** documentación vigente · **C** histórico valioso · **D** temporal o regenerable · **E** candidato a eliminación · **F** revisión del propietario. D y E **no** autorizan borrar: cada bloque del §11 necesita aprobación.

---

## 1. Resumen ejecutivo

- **El código está ordenado; el disco no.** Los 681 archivos versionados (14,3 MB) tienen una estructura coherente. El desorden está casi entero en material **ignorado por Git** dentro de `tmp/`.
- **La carpeta ocupa 5,54 GiB (5 675 MB) en 179 934 archivos y 4 347 carpetas.** El **80 %** (4 554 MB, 128 256 archivos) son **25 clústeres PostgreSQL de prueba abandonados** en `tmp/saas-phase01/pgdata-*`: el script de pruebas los borra al terminar, pero las ejecuciones interrumpidas los dejan. Un proceso `postgres.exe` huérfano sigue vivo desde el 2026-10-20.
- **No hay ZIP, JPG, vídeos ni descargas** en la carpeta. Las «capturas» son 2 744 PNG de pruebas automáticas (261 MB) dentro de `tmp/`.
- **Recuperables sin pérdida: ~4,8 GB (≈ 139 700 archivos)**, todo regenerable (clústeres de prueba, copias de compilaciones, una copia del repositorio, bundles de pruebas, `node_modules` de un experimento cerrado). No requiere respaldo previo.
- **Lo delicado:** los documentos de las rondas citan **59 rutas dentro de `tmp/`** (arneses `e2e.mjs`, instantáneas, registros). Esos arneses **nunca se versionaron**: Git no los protege. Antes de cualquier poda adicional de `tmp/` hace falta un respaldo independiente.
- **Raíz del proyecto:** 11 documentos de junio–septiembre (etapa CLEAN) mezclados con la configuración. Se propone moverlos a `docs/historico/`. `docs/` **no** se reestructura: tiene 193 enlaces relativos entre documentos y el Registro maestro depende de ellos.
- **CLEAN (`src/`, `public/`, `index.html`, `tailwind.config.js`) es OPERATIVO**, aunque su web esté retirada: Online lo compila y la API de Render importa sus reglas.

---

## 2. Estadísticas del inventario

### 2.1 Por estado frente a Git

| Estado | Archivos | Tamaño |
|---|---:|---:|
| Versionados | 681 | 14,3 MB |
| Sin seguimiento (no ignorados) | 2 | 0,02 MB |
| Ignorados | 179 251 | 5 660,8 MB |
| **Total** | **179 934** (4 347 carpetas) | **5 675 MB** |

Repositorio Git (`.git`, no contado arriba): 43,8 MB empaquetados.

### 2.2 Por categoría de contenido

| Categoría | Archivos | Tamaño | Clase |
|---|---:|---:|---|
| Clústeres PostgreSQL de prueba (`tmp/saas-phase01/pgdata-*`) | 128 256 | 4 553,8 MB | D |
| Clústeres de ensayo Fase 0A.1 (`tmp/saas-phase0a1/rehearsal-*`) | 1 944 | 78,7 MB | D |
| Copias de compilaciones dentro de `tmp/` (`dist*`, `build-*`) | 2 130 | 111,8 MB | D |
| Copia del repositorio para ensayo Docker (`tmp/adex-online-render/app`) | 5 372 | 30,1 MB | D |
| `node_modules` del experimento cerrado (`experiments/saas-phase0a/`) | 1 991 | 123,3 MB | D |
| Bundles de pruebas de CLEAN (`tests/_out*.mjs`) | 27 | 10,9 MB | D |
| Resto de `tmp/`: evidencias, arneses, registros, capturas | 4 201 | 277,6 MB | C / F |
| — de ello, capturas PNG | 2 173 | 230,7 MB | C / D |
| `node_modules` en uso (raíz, `online/`, `saas/`) | 35 236 | 471,5 MB | A (regenerable) |
| Código, documentación y configuración (resto) | 783 | 18,1 MB | A / B / C |

### 2.3 Por carpeta principal

| Carpeta | Tamaño | Estado Git | Comentario |
|---|---:|---|---|
| `tmp/` | 4 942 MB | Ignorada | 92 % del total; ver §4 |
| `node_modules/` (raíz) | 193 MB | Ignorada | Pruebas y build de CLEAN |
| `online/` | 159 MB | 117 versionados | 155 MB son `node_modules` |
| `saas/` | 125 MB | 168 versionados | 123 MB son `node_modules` (incluye PostgreSQL embebido) |
| `experiments/` | 124 MB | 35 versionados | 123 MB son `node_modules` |
| `tests/` | 12 MB | 33 versionados | 11 MB son `_out*.mjs` |
| `src/` | 9 MB | 230 versionados | 5,8 MB son logos (maestros + optimizados + web) |
| `dist/`, `online/dist/` | 3,7 MB | Ignoradas | Salidas de build locales |
| `docs/` | 1,2 MB | 62 versionados + 1 sin seguimiento | |
| Raíz (archivos sueltos) | 0,3 MB | 22 versionados | 11 son documentos históricos |

---

## 3. Directorios principales y función

| Ruta | Función | Clase |
|---|---|---|
| `src/` | Frontend de CLEAN. **Online lo compila** (`online/vite.config.ts`, `CLEAN_SRC = ../src`) y la imagen de Render copia `src/` para reutilizar sus reglas (DS-01) | A |
| `public/` | Iconos y favicons; `online/` los usa como `publicDir` | A |
| `index.html`, `vite.config.ts`, `tsconfig*.json`, `postcss.config.js`, `tailwind.config.js`, `package*.json` | Build y pruebas de CLEAN; `tailwind.config.js` lo importa Online | A |
| `vercel.json` (raíz) | Proyecto Vercel de CLEAN (web retirada en R59) | F |
| `online/` | Frontend publicado (`adex-online.vercel.app`, `/owner`), puente de datos, puerta de despliegue | A |
| `saas/` | API, migraciones (`db/migrations/`), pruebas, scripts de staging | A |
| `deploy/` | Dockerfile y `render.yaml` (en uso); `digitalocean/app.yaml` (preparado, no aplicado) | A / B |
| `scripts/` | `verify-deploy.mjs`, `prod-smoke.mjs` (apuntan a la URL retirada de CLEAN), scripts de logos | A |
| `tests/` | Pruebas de CLEAN (`npm test`) | A |
| `experiments/saas-phase0a/` | Prueba de concepto Fase 0A/0A.1 (cerrada). Citado por 4 documentos | C |
| `docs/` | Visión, decisiones, arquitectura, resultados de fases y rondas, Registro maestro | B / C |
| `tmp/` | Salidas de pruebas, arneses e2e, capturas, registros, clústeres locales (ignorada) | C / D / F |
| `.claude/settings.json` | Configuración de Claude Code del proyecto | A |
| `.impeccable/` | Configuración local de una herramienta de revisión de diseño | F |

---

## 4. Problemas reales identificados

| # | Problema | Evidencia | Impacto |
|---|---|---|---|
| P1 | **25 clústeres PostgreSQL abandonados** | `tmp/saas-phase01/pgdata-*` (2026-10-14 → 2026-10-22); `saas/scripts/local-cluster.ts` los borra en `stop()`, que no corre si la ejecución se interrumpe | 4,55 GB y 128 mil archivos (lentitud de búsquedas, antivirus, copias) |
| P2 | **Proceso `postgres.exe` huérfano** | PID 35916, iniciado 2026-10-20 23:30, binario de `saas/node_modules/@embedded-postgres`; coincide con `pgdata-r59vis-1792557157493` | Bloquea el borrado de esa carpeta; consume memoria |
| P3 | **Evidencia no versionada citada por documentos oficiales** | 59 rutas `tmp/...` en `docs/` (p. ej. `tmp/r39/fin.mjs`, `tmp/r67/e2e.mjs`, `tmp/r62/snapshot-antes.json`); 1 632 scripts en `tmp/` | Si se pierde el disco, se pierde la forma de repetir las pruebas |
| P4 | **Copias de compilaciones en cada ronda** | 79 carpetas `dist*`/`build-*` dentro de `tmp/` (p. ej. 15 en `tmp/r24/run-*/dist/`) | 112 MB regenerables |
| P5 | **Capturas repetidas** | 2 744 PNG; `tmp/prod-smoke/` tiene 32 ejecuciones (549 PNG) contra la CLEAN ya retirada | 261 MB |
| P6 | **Raíz con documentos históricos** | `CAMBIOS_*.md` (7), `AUDITORIA_RUTACASH_V1_SOCIO.md`, `PROMPT.md`, `README_MIGRACION_RUTACASH.md`; no hay `README.md` de raíz | Dificulta saber qué es vigente |
| P7 | **Duplicado exacto sin seguimiento** | `docs/OFICINAS_RUTACASH_2026-09.html` es idéntico byte a byte a `docs/ENTREGABLE_SOCIO_OFICINAS_RUTACASH_2026-09.html` (versionado) | Ruido; aparece siempre en `git status` |
| P8 | **`.gitignore` de raíz incompleto** | No ignora `.env*`, `*.pem`, `*.crt`, `*.key` (solo lo hacen `saas/`, `online/` y `experiments/`); 27 líneas `tests/_out.*.mjs` una por una | Un `.env` creado en la raíz podría versionarse por error |
| P9 | **Material sensible disperso en `tmp/`** | `tmp/accesos/` (pruebas de Owner y purga: `pre.json`, `post.json`, `purge-*.log`), `tmp/saas-phase0a1/cert/`; 20+ scripts con patrones de credenciales o URLs de conexión (no se abrieron sus valores) | No debe versionarse ni copiarse a ubicaciones compartidas |
| P10 | **Carpeta `tmp/tmp/` anidada** | `tmp/tmp/c1`, `tmp/tmp/r49` (6,2 MB): se ejecutó un arnés con el directorio de trabajo equivocado | Duplica evidencia de C1/R49 |

No se encontró: archivos ZIP, imágenes JPG, vídeos, descargas del navegador, archivos `.docx`/`.xlsx`, copias de bases de datos de BlueLine ni de staging.

---

## 5. Elementos protegidos (no tocar)

| Elemento | Motivo |
|---|---|
| `src/`, `public/`, `index.html`, `tailwind.config.js`, `postcss.config.js`, `tsconfig*.json`, `vite.config.ts`, `package*.json` de raíz | Online compila `../src` y usa `../public` y `../tailwind.config.js`; el Dockerfile copia `src/` |
| `src/assets/branding/adex/` (maestros) y `optimized/` | Solo `web/` se importa (`BrandLogo.tsx`), pero los otros dos son la fuente de `scripts/*brand*.py` |
| `online/` (todo lo versionado), `online/scripts/deploy-gate.mjs` | Despliegue de Vercel (`ignoreCommand`) |
| `saas/` (todo lo versionado), en especial `saas/db/migrations/` | Migraciones: intocables sin autorización |
| `deploy/adex-online-api/`, `deploy/render/render.yaml`, `.dockerignore` | Imagen de los dos servicios de Render |
| `saas/.env.staging`, `saas/.env.online`, `experiments/saas-phase0a/.env.managed` | Credenciales locales (ignoradas). No se mueven, copian ni versionan |
| `docs/` (todo lo versionado) | 193 enlaces relativos; el Registro maestro enlaza `./<documento>.md` |
| `node_modules/` de raíz, `online/`, `saas/` | Necesarios para trabajar (regenerables con `npm ci`, pero sin beneficio en borrarlos) |
| `stash@{0}` (Ronda 23 rechazada) y `tmp/ronda23-respaldo/` | Respaldo explícito de trabajo rechazado; no reutilizar, pero tampoco borrar sin decisión |
| `tmp/saas-phase01/evidence/`, `tmp/saas-phase0a/evidence/`, `tmp/saas-phase0a1/evidence/` | Citados como evidencia en documentos de fases |

---

## 6. Candidatos a eliminación

Todos están **ignorados por Git** y son **regenerables**: no hacen falta respaldo. Ninguno es leído por el build de Vercel, la imagen de Render (el `.dockerignore` excluye `tmp`, `tests`, `experiments`) ni las pruebas.

| # | Ruta exacta | Archivos | Tamaño | Clase | Referencias | Cómo se regenera | Riesgo |
|---|---|---:|---:|---|---|---|---|
| E1 | `tmp/saas-phase01/pgdata-*` (25 carpetas, lista en §A.1) | 128 256 | 4 553,8 MB | D | Solo el patrón en `local-cluster.ts` (crea y borra) | `npm run test:db` crea uno nuevo cada vez | Bajo. Detener antes el PID huérfano (P2) |
| E2 | `tmp/saas-phase0a1/rehearsal-1791931376509/`, `tmp/saas-phase0a1/rehearsal-1791931389002/` | 1 944 | 78,7 MB | D | Ninguna; la evidencia está en `tmp/saas-phase0a1/evidence/` (se conserva) | Ensayo de la Fase 0A.1 (cerrada) | Bajo |
| E3 | Copias de compilaciones en `tmp/` (79 carpetas, lista en §A.2) | 2 130 | 111,8 MB | D | Ninguna en `docs/` | `git checkout <commit>` + `npm run build` | Bajo: los nombres de bundle publicados ya constan en los documentos |
| E4 | `tmp/adex-online-render/app/` | 5 372 | 30,1 MB | D | Ninguna | Copia del repositorio para ensayar la imagen Docker (R16) | Bajo |
| E5 | `experiments/saas-phase0a/node_modules/` | 1 991 | 123,3 MB | D | Ninguna | `npm ci` en esa carpeta (lock versionado) | Bajo. El experimento está cerrado |
| E6 | `tests/_out*.mjs` (27 archivos) | 27 | 10,9 MB | D | Scripts `test:*` de `package.json` los **reescriben** en cada ejecución | `npm test` | Ninguno |
| E7 | `docs/OFICINAS_RUTACASH_2026-09.html` | 1 | 0,02 MB | E | Su nombre aparece en 2 documentos de Fase 0A como nombre anterior del entregable | Duplicado exacto de `docs/ENTREGABLE_SOCIO_OFICINAS_RUTACASH_2026-09.html` | Ninguno. **Sin seguimiento**: Git no lo recupera, pero su contenido idéntico sí está versionado |
| | **Total bloque de eliminación segura** | **≈ 139 720** | **≈ 4 909 MB (4,8 GB)** | | | | |

Tras el bloque, la carpeta quedaría en **≈ 0,77 GB** (471 MB de `node_modules` en uso + 278 MB de evidencias + 18 MB de proyecto).

### 6.1 Eliminación opcional (solo después del respaldo del §11 · Bloque 0)

| Ruta | Archivos | Tamaño | Motivo | Riesgo |
|---|---:|---:|---|---|
| `tmp/prod-smoke/` (32 ejecuciones del smoke de CLEAN, 2026-09-30 → 10-12) | 581 | 54,6 MB | CLEAN está retirada; los documentos solo citan la carpeta, no una ejecución | Bajo con respaldo |
| `tmp/tmp/` | 72 | 6,2 MB | Ejecución con directorio equivocado (P10) | Bajo con respaldo |
| Ejecuciones repetidas `tmp/r24/run-*`, `tmp/r25/run-*`, `tmp/r26/run-*`, `tmp/r26/r26o-*`, `tmp/adm/run-*`, conservando la última de cada ronda | ~1 000 | ~60 MB | Repeticiones del mismo e2e; la cifra final está en el documento de la ronda | Bajo con respaldo |
| Registros sueltos de la raíz de `tmp/` (160 `.log`, 7,1 MB) | 175 | 7,1 MB | Salidas de `npm test` de rondas 1–6, Fases 0–4 | Bajo con respaldo |

Ahorro opcional: **~0,13 GB**. Poco espacio; el valor es claridad. Se puede posponer sin coste.

---

## 7. Candidatos a archivo o movimiento

### 7.1 Documentos históricos de la raíz → `docs/historico/clean-2026/`

Versionados (recuperables por Git). Todas las referencias entrantes son menciones en texto, no enlaces, salvo donde se indica.

| Ruta actual | Fecha | Propósito | Referencias entrantes | Clase |
|---|---|---|---|---|
| `AUDITORIA_RUTACASH_V1_SOCIO.md` | 09-18 | Auditoría V1 para el socio | Texto en `CAMBIOS_RUTACASH_CONSOLIDADO.md`, `PROMPT.md`, `README_MIGRACION_RUTACASH.md` (se mueven juntos) | C |
| `CAMBIOS_AJUSTES_ABONO_TOOLTIP_HISTORIAL.md` | 07-05 | Cambios etapa CLEAN | Ninguna | C |
| `CAMBIOS_AJUSTES_POST_REVISION_2.md` | 07-05 | Idem | Ninguna | C |
| `CAMBIOS_AJUSTE_PARCELAS_VENTAS_TOOLTIP.md` | 07-05 | Idem | Ninguna | C |
| `CAMBIOS_KPI_APP_COBRADOR_AJUSTE_FINAL.md` | 06-26 | Idem | Ninguna | C |
| `CAMBIOS_RESET_APP_LIMPIA.md` | 06-23 | Idem | Texto en `CAMBIOS_RUTACASH_CONSOLIDADO.md` | C |
| `CAMBIOS_REVISION_2_SOCIO_30_JUNIO.md` | 07-04 | Idem | Ninguna | C |
| `CAMBIOS_RUTACASH_CONSOLIDADO.md` | 06-23 | Idem | Ninguna | C |
| `CAMBIOS_SOCIO_REVISION_25_JUNIO.md` | 06-26 | Idem | **Texto** en `docs/INCIDENTE_SEGUNDO_CREDITO_ACTIVO_2026-09.md` (líneas 25 y 62): actualizar la ruta citada | C |
| `PROMPT.md` | 06-21 | Prompt inicial del proyecto (RutaCash) | Ninguna | C |
| `README_MIGRACION_RUTACASH.md` | 06-20 | Nota de migración CobrosApp → RutaCash | Texto en `CAMBIOS_RUTACASH_CONSOLIDADO.md`, `PROMPT.md` | C |
| `docs/manual-rapido-demo.md` | 06-18 | Manual de la demo V1 (CLEAN) | Ninguna | C |
| `docs/functional-scope-v1.md` | 06-18 | Alcance V1 (CLEAN) | Ninguna entrante; tiene **un enlace saliente** a `future-roadmap.md` que hay que ajustar a `../../future-roadmap.md` | C |

Se quedan donde están, aunque sean antiguos: `docs/database-schema.md` y `docs/future-roadmap.md` (enlazados desde la Visión, la auditoría SaaS y un comentario de `SettingsPage.tsx`), y el entregable `docs/ENTREGABLE_SOCIO_OFICINAS_RUTACASH_2026-09.{md,html,pdf}` (citado por los documentos de Fase 0A).

### 7.2 Evidencias de `tmp/` (clase C): **conservar en su sitio**

Las 59 rutas citadas por `docs/` (lista completa con `git grep -ohE "tmp/[A-Za-z0-9_./-]+" -- docs`) quedan donde están. Moverlas rompería las citas de documentos históricos, que no se reescriben. Lo que se propone es **respaldarlas** (Bloque 0) y **podar lo regenerable** dentro de ellas (E3).

Carpetas con arneses citados: `tmp/accesos`, `tmp/adm`, `tmp/adex-online-v1/e2e`, `tmp/exp-class-e2e`, `tmp/f6`, `tmp/pay-rev-e2e`, `tmp/pay-sync-e2e`, `tmp/r24`, `tmp/r25`, `tmp/r26`, `tmp/r39`, `tmp/r40`, `tmp/r47`, `tmp/r48`, `tmp/r53`, `tmp/r59`, `tmp/r62`, `tmp/r65`, `tmp/r65c1`, `tmp/r67`, `tmp/sup-base-e2e`, `tmp/worker-xfer-e2e`, `tmp/prod-smoke`, `tmp/ronda23-respaldo`, `tmp/saas-phase0a*/evidence`, `tmp/saas-phase01/evidence`.

**No se propone versionar los arneses en bloque:** al menos 20 contienen patrones de credenciales o URLs de conexión. Si una ronda futura necesita reutilizar uno, se promueve **ese** arnés a `saas/scripts/` o `scripts/` tras revisarlo (regla R7).

---

## 8. Revisión del propietario (clase F)

| Elemento | Pregunta | Recomendación |
|---|---|---|
| `tmp/accesos/` (60 archivos, 1,9 MB) | Contiene pruebas de Owner y la purga de R54 (`pre.json`, `post.json`, `purge-*.log`), con posibles correos o identificadores reales. ¿Se conserva? | Conservar en el respaldo **privado**; no compartir |
| Capturas de pantalla de la aplicación publicada (`tmp/r26/published-*`, `tmp/r67/`, `tmp/r59/visual`, …) | Pueden mostrar datos de cuentas reales (Owner, BlueLine). ¿Pueden ir a un respaldo en la nube? | Solo a ubicación privada |
| `vercel.json` de raíz | ¿Sigue existiendo el proyecto Vercel de CLEAN (`rutacash-clean`, 404 desde R59)? Si se borró en Vercel, el archivo es configuración muerta | Dejarlo hasta confirmarlo; no estorba |
| `.impeccable/config.json` (sin seguimiento) | Guarda excepciones de una herramienta de revisión de diseño. ¿Versionar o ignorar? | Ignorar (añadir a `.gitignore`); es preferencia local |
| `experiments/saas-phase0a/` | Experimento cerrado, citado por 4 documentos. El proyecto gestionado de 0A.1 sigue con teardown pendiente | Mantener versionado; solo borrar su `node_modules` (E5) |
| `deploy/digitalocean/app.yaml` | Alternativa preparada y no aplicada | Mantener como documentación de opción |
| `stash@{0}` + `tmp/ronda23-respaldo/` | Ronda 23 rechazada | Mantener (no ocupa espacio relevante) |
| `scripts/prod-smoke.mjs`, `verify:deploy` | Apuntan a la URL retirada de CLEAN (pendiente ya registrado en el Registro maestro §G) | Fuera del alcance de esta reorganización |

---

## 9. Dependencias y riesgos

| Riesgo | Detalle | Mitigación |
|---|---|---|
| Borrar `src/`, `public/` o la configuración de raíz «porque CLEAN está retirada» | Rompe el build de Vercel (`adex-online`) y la imagen de Render | Están en §5 (protegidos) |
| Mover documentos de `docs/` | 193 enlaces `./X.md` y enlaces `../src/...`; el Registro maestro enlaza por ruta | Solo se mueven 2 documentos sin enlaces entrantes (§7.1); comprobar enlaces (§11) |
| Borrar un `pgdata` en uso | PID 35916 lo mantiene abierto; un `test:db` en curso usa el más reciente | Detener el proceso huérfano y comprobar que no hay pruebas en marcha |
| Perder arneses no versionados | Git no los guarda | Bloque 0 (respaldo) antes de cualquier poda de evidencia |
| Filtrar credenciales | `.env*`, `tmp/accesos/`, scripts con URLs de conexión | Nunca versionar, nunca copiar a la carpeta padre compartida; respaldo solo en ubicación privada |
| Recompilación de Vercel | Todo push a `main` hace que Vercel evalúe `adex-online` (la puerta mira `/healthz`) | Normal; sin cambio funcional. Render no se despliega solo |
| Borrar por patrón demasiado amplio | P. ej. `dist` también existe en `node_modules/*/dist` | Usar las rutas exactas del §A, nunca un patrón global |

---

## 10. Estructura futura propuesta

Cambios mínimos; las carpetas técnicas no se tocan.

```
RutaCash/
├─ README.md                    ← NUEVO, corto: qué es cada carpeta + enlace al Registro maestro
├─ src/  public/  tests/        ← CLEAN (operativo: lo compila Online)
├─ online/  saas/  deploy/  scripts/
├─ experiments/                 ← solo código versionado (sin node_modules)
├─ docs/
│  ├─ REGISTRO_MAESTRO_EVOLUCION_ADEX.md   ← índice oficial (sin cambios)
│  ├─ VISION_…  ADEX_RONDA_NN_…  SAAS_FASE_…  (sin cambios: plano, como hoy)
│  └─ historico/
│     └─ clean-2026/            ← los 11 documentos de la raíz + 2 de docs/ (§7.1)
├─ tmp/                         ← ignorada: tmp/rNN/ por ronda (convención ya en uso)
└─ (configuración de raíz: package.json, vite.config.ts, vercel.json, .gitignore…)
```

No se crean carpetas de evidencia nuevas: `tmp/rNN/` ya es la convención citada por los documentos. Lo que cambia es la **poda al cerrar cada ronda** (§12, regla R4).

---

## 11. Plan de ejecución por bloques

Cada bloque se ejecuta solo con la aprobación escrita del propietario («apruebo el bloque N»). Orden recomendado: 1 → 2 → 3 → 0 → 4. El Bloque 0 solo es obligatorio antes del Bloque 4.

| Bloque | Operaciones | Ahorro | Requiere | Reversible por |
|---|---|---:|---|---|
| **1 · Limpieza regenerable** | (a) Comprobar que no hay pruebas en marcha y detener el `postgres.exe` huérfano (PID 35916, si sigue vivo). (b) Borrar E1–E6 con las rutas exactas del §A. (c) Borrar E7 | 4,9 GB | Aprobación | Regeneración (§6) |
| **2 · Raíz despejada** | (a) `git mv` de los 11 documentos de la raíz y de `docs/manual-rapido-demo.md`, `docs/functional-scope-v1.md` a `docs/historico/clean-2026/`. (b) Ajustar el enlace saliente de `functional-scope-v1.md` y las 2 menciones de `INCIDENTE_SEGUNDO_CREDITO_ACTIVO_2026-09.md`. (c) Crear `README.md` de raíz (≤ 40 líneas). (d) Una fila en el Registro maestro. Un commit | — | Aprobación | Git |
| **3 · `.gitignore`** | Sustituir las 27 líneas `tests/_out.*.mjs` por `tests/_out*.mjs`; añadir en la raíz `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.crt`, `*.key`, `.impeccable/`, `*.zip`. Comprobar con `git status --ignored` que no cambia lo versionado. Un commit | — | Aprobación | Git |
| **0 · Respaldo independiente** | Copiar `tmp/` **sin** E1–E4 (≈ 278 MB) a una ubicación **privada** elegida por el propietario (disco externo o nube personal), **no** a la carpeta padre `01_PRODUCTOS_COMERCIALES/` ni a Git. Verificar número de archivos y tamaño de la copia | — | Ubicación del propietario | — |
| **4 · Poda opcional de evidencias** | Lo del §6.1 | ~0,13 GB | Bloque 0 verificado + aprobación | Respaldo del Bloque 0 |
| **Pendiente** | `tmp/accesos/`, capturas con datos reales, `vercel.json` de raíz, `.impeccable/config.json` | — | Decisión (§8) | — |

---

## 12. Reglas permanentes de organización

Pensadas para que Claude Code las aplique solo, al cerrar cada ronda, sin auditorías recurrentes.

| # | Regla |
|---|---|
| R1 | **Documentos nuevos:** en `docs/`, con el nombre `ADEX_RONDA_NN_<TEMA>.md` (rondas) o `<TEMA>_<AAAA-MM>.md` (normativos). Nunca en la raíz |
| R2 | **Registro maestro:** se actualiza en el mismo commit documental que cierra la ronda, siguiendo su §H. Es el único índice; no se crean otros |
| R3 | **Salidas de cada ronda** (arneses, registros, capturas, instantáneas): solo en `tmp/rNN/` (ignorada). Nunca en la carpeta padre ni en `docs/` |
| R4 | **Poda al cierre de ronda** (sin pedir permiso, porque es regenerable): borrar en `tmp/rNN/` las copias de compilaciones (`dist*`, `build-*`) y cualquier `tmp/saas-phase01/pgdata-*` que no pertenezca a una prueba en curso. Conservar: arneses, registro final, instantáneas JSON y las capturas de la **última** ejecución |
| R5 | **Capturas:** por defecto en `tmp/rNN/`. Solo se versiona una captura si un documento la incrusta, en `docs/img/rNN/`, en PNG optimizado y sin datos reales |
| R6 | **ZIP y exportaciones:** no se generan salvo petición. Un documento se entrega en un formato; si hacen falta varios (MD/HTML/PDF), se versiona la fuente y la exportación final, nunca copias con otro nombre |
| R7 | **Arneses reutilizables:** si una ronda reutiliza un arnés de otra, se promueve a `scripts/` o `saas/scripts/`, tras comprobar que no contiene credenciales (solo variables de entorno) |
| R8 | **Nunca se versiona:** `.env*` (salvo `.env.example`), certificados y claves, contenido de `tmp/`, `node_modules/`, `dist/`, volcados de base de datos, datos de BlueLine u Owners, capturas con datos reales |
| R9 | **Quién aprueba eliminaciones:** el propietario, por escrito. Excepción: lo de R4 y los temporales de la ronda en curso. Lo que nunca fue versionado y no es regenerable se borra solo tras respaldo verificado |
| R10 | **Antes de mover o renombrar:** `git grep -n "<nombre>"` en todo el repositorio (código, `docs/`, `package.json`, `vercel.json`, `render.yaml`, `Dockerfile`, `.dockerignore`); actualizar cada referencia en el mismo commit; ejecutar los criterios del §13 |
| R11 | **Revisión al cerrar ronda** (≤ 2 minutos): `git status` sin archivos sin seguimiento inesperados; nada nuevo en la raíz; R4 aplicada; Registro maestro actualizado |

---

## 13. Criterios para comprobar que la reorganización no rompió nada

Tras cada bloque:

1. `git status`: solo los cambios del bloque; ningún archivo versionado borrado por accidente (`git ls-files --deleted` vacío salvo los `git mv` previstos).
2. Build de Online: `cd online && npm run build` → termina sin errores y genera `dist/index.html`, `dist/owner.html`, `dist/sw.js`.
3. Build y pruebas de CLEAN: `npm run build` y `npm test` en la raíz → mismos totales que antes.
4. API: `cd saas && npm run typecheck && npm run test:unit`; `npm run test:db` crea **un** `pgdata-*` y lo elimina al terminar.
5. Imagen Docker (opcional, si hay Docker): `docker build -f deploy/adex-online-api/Dockerfile .` desde la raíz.
6. Enlaces de `docs/` (Bloque 2): script de una línea que recorra los `](./…)` y `](../…)` de `docs/**/*.md` y confirme que cada destino existe → 0 enlaces rotos.
7. Bloque 0: el número de archivos y el tamaño de la copia coinciden con el origen.
8. Servicios publicados: no se tocan. `/healthz` de las dos API y el bundle de `adex-online.vercel.app` solo cambian por la recompilación normal del push.

---

## 14. Esta ronda

| | |
|---|---|
| Alcance | Solo crear este documento. Sin borrar, mover ni renombrar; sin cambios de código, migraciones, bases de datos, BlueLine, Owner, variables ni despliegues manuales |
| Lecturas | Sistema de archivos local, Git, configuración de build y despliegue. Ninguna consulta remota |
| Hallazgo operativo | Proceso `postgres.exe` huérfano (PID 35916) de pruebas locales: no se detuvo (requiere aprobación, Bloque 1) |
| Efecto del push | Vercel evalúa `adex-online` con la puerta de despliegue; si recompila, cambia el nombre del bundle sin cambio funcional. Render no se despliega solo |

---

## Apéndice A · Rutas exactas

### A.1 Clústeres PostgreSQL abandonados (E1) — todas en `tmp/saas-phase01/`

Fecha en UTC, del sello en milisegundos del nombre.

| Carpeta | Fecha | Tamaño |
|---|---|---:|
| `pgdata-try-1791996651796` | 10-14 16:50 | 39,4 MB |
| `pgdata-tests-1792003825002` | 10-14 18:50 | 39,3 MB |
| `pgdata-tests-1792004595127` | 10-14 19:03 | 39,3 MB |
| `pgdata-tests-1792024722854` | 10-15 00:38 | 46,9 MB |
| `pgdata-tests-1792184870003` | 10-16 21:07 | 49,9 MB |
| `pgdata-tests-1792184883191` | 10-16 21:08 | 49,9 MB |
| `pgdata-rebuild-1792184897947` | 10-16 21:08 | 49,9 MB |
| `pgdata-rebuild-1792184935202` | 10-16 21:08 | 49,9 MB |
| `pgdata-rebuild-1792184973774` | 10-16 21:09 | 49,9 MB |
| `pgdata-tests-1792186123203` | 10-16 21:28 | 77,8 MB |
| `pgdata-tests-1792378769859` | 10-19 02:59 | 79,9 MB |
| `pgdata-tests-1792379745822` | 10-19 03:15 | 707,6 MB |
| `pgdata-tests-1792452142225` | 10-19 23:22 | 751,3 MB |
| `pgdata-tests-1792477067552` | 10-20 06:17 | 797,0 MB |
| `pgdata-tests-1792478657696` | 10-20 06:44 | 797,4 MB |
| `pgdata-tests-1792520504452` | 10-20 18:21 | 79,7 MB |
| `pgdata-tests-1792553285055` | 10-21 03:28 | 51,4 MB |
| `pgdata-tests-1792553304702` | 10-21 03:28 | 51,4 MB |
| `pgdata-r59vis-1792556412107` | 10-21 04:20 | 81,3 MB |
| `pgdata-r59vis-1792557157493` | 10-21 04:32 | 81,4 MB ← probable carpeta del PID 35916 |
| `pgdata-tests-1792566354756` | 10-21 07:05 | 46,9 MB |
| `pgdata-r65off-1792597058922` | 10-21 15:37 | 81,1 MB |
| `pgdata-r65off-1792598413770` | 10-21 16:00 | 81,2 MB |
| `pgdata-tests-1792631164055` | 10-22 01:06 | 121,6 MB |
| `pgdata-tests-1792631650197` | 10-22 01:14 | 252,6 MB |

Se conservan en `tmp/saas-phase01/`: `evidence/`, `render/` y los `.log` sueltos.

### A.2 Copias de compilaciones dentro de `tmp/` (E3)

| Ronda | Carpetas |
|---|---|
| `tmp/accesos/` | `owner-8db346/dist/`, `owner-dcaa48/dist/`, `owner-e78e75/dist/` |
| `tmp/adm/` | `run-0e5899/dist/`, `run-3e5d26/dist/`, `run-61992d/dist/`, `run-83249a/dist/`, `run-88b386/dist/`, `run-ad7e3f/dist/` |
| `tmp/` | `adm-build-check/`, `r17-build/` |
| `tmp/clean-ui/` | `build-check/`, `build-head/` |
| `tmp/r24/` | `build-head/`, `build-now/`, `run-0a30e3/dist/`, `run-1279e8/dist/`, `run-1f054d/dist/`, `run-2f823f/dist/`, `run-419815/dist/`, `run-428fa8/dist/`, `run-483d13/dist/`, `run-5970af/dist/`, `run-5e211c/dist/`, `run-5f5903/dist/`, `run-8c444f/dist/`, `run-9a9632/dist/`, `run-a319f4/dist/`, `run-b6bd69/dist/`, `run-d734b7/dist/` |
| `tmp/r25/` | `build-check/`, `run-23e0fc/dist/`, `run-2dc982/dist/`, `run-663f8d/dist/`, `run-811568/dist/`, `run-8a8125/dist/`, `run-a6fe63/dist/`, `run-cbfddf/dist/`, `run-d7b94e/dist/` |
| `tmp/r26/` | `build-check/`, `r26o-198864/dist/`, `r26o-2e3e51/dist/`, `r26o-ae58e6/dist/`, `r26o-afc04e/dist/`, `run-33e359/dist/`, `run-4c3658/dist/`, `run-6539c5/dist/`, `run-661b3f/dist/`, `run-68585f/dist/`, `run-78196a/dist/`, `run-7b5907/dist/`, `run-aa4186/dist/`, `run-b7ac88/dist/`, `run-cceae5/dist/`, `run-fa6381/dist/` |
| `tmp/r40/` | `local-103f31/dist/`, `local-471e18/dist/` |
| `tmp/r48/` | `build-clean/`, `build-online/` |
| `tmp/r48-1/` | `build-clean/`, `build-online/` |
| `tmp/r49/` | `build-online/`, `visual/dist/` |
| `tmp/r53/` | `visual/dist/` |
| `tmp/r59/` | `visual/dist/` |
| `tmp/r62/` | `build-check/`, `dist/` |
| `tmp/r65/` | `dist/`, `dist-r62/` |
| `tmp/r65c1/` | `dist/`, `dist-r65-viejo/` |
| `tmp/r67/` | `dist/`, `dist-std/`, `c1/dist/`, `r62/dist/` |

Solo se borran esas carpetas; los scripts y registros que estén a su lado se conservan.
