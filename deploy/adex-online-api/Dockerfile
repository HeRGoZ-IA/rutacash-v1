# ADEX Online v1 · imagen del API (DigitalOcean App Platform u otro alojamiento de contenedores).
#
# Contexto de construcción: la RAÍZ del repositorio (el API importa las reglas de CLEAN
# de `src/lib`, `src/models` y `src/services/installmentEngine.ts` sin copiarlas, DS-01).
# Node 24 ejecuta TypeScript sin compilar (eliminación de tipos); no hay paso de build.
# Ningún secreto entra en la imagen: toda la configuración llega por variables de entorno.

FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Dependencias de ejecución de las reglas de CLEAN que el API reutiliza (versiones exactas del lock de CLEAN).
COPY deploy/adex-online-api/package.json deploy/adex-online-api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Dependencias del API (jose, pg). Sin embedded-postgres ni herramientas de prueba.
COPY saas/package.json saas/package-lock.json saas/.npmrc ./saas/
RUN cd saas && npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY saas/src ./saas/src
COPY saas/scripts/register-alias.mjs saas/scripts/alias-hooks.mjs ./saas/scripts/

USER node
WORKDIR /app/saas
EXPOSE 8080
CMD ["node", "--import", "./scripts/register-alias.mjs", "src/server/main.ts"]
