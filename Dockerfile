# syntax=docker/dockerfile:1

# =============================================================================
# residguard_ws — imagen de liberación (patrón de notificacion_project/smtp-service)
# =============================================================================
# PARTICULARIDAD DE ESTE SERVICIO: depende de la lib local
#   structure-verifier: file:../../libs/structure-verifier
# que vive FUERA de este directorio. Se resuelve con un build context ADICIONAL
# de BuildKit y replicando dentro de la imagen el layout local
# (…/residguard_v2/residguard_ws + …/libs/structure-verifier), para que la ruta
# relativa del package.json resuelva igual que en desarrollo.
#
# CÓMO CONSTRUIR (desde este directorio):
#   docker build --build-context libs=../../libs -t residguard-ws .
# Requiere BuildKit (default en Docker moderno) y que la lib tenga su dist/
# generado (npx tsc en D:\Projects\libs\structure-verifier si faltara).
#
# CÓMO CORRER (la config viaja por variables de entorno, nunca en la imagen):
#   docker run -p 3004:3004 -e NODE_ENV=production \
#     -e DATABASE_URL=postgresql://role_app:<secret>@db:5432/residguard_db \
#     -e AUTH_WS_BASE_URL=https://api-auth.residguard.site \
#     -e CORS_ORIGINS=https://<origen-del-spa> \
#     residguard-ws
# =============================================================================

# ── Etapa 1: build ──────────────────────────────────────────────────────────
# node:24-slim (Debian/glibc): pg trae prebuilds nativos fiables; alpine (musl)
# obligaría a compilar desde fuente. Node 24 coincide con el entorno local.
# pnpm vía corepack: pnpm-lock.yaml es la fuente de verdad.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Store en /pnpm/store: coincide con el cache mount y, al estar en otro mount
# que node_modules, pnpm COPIA los paquetes a node_modules (autocontenido) en
# vez de hardlinkear -> se puede copiar tal cual a la imagen final.
ENV PNPM_STORE_DIR=/pnpm/store
# Sin prompt interactivo al aprovisionar el pnpm fijado en "packageManager".
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Lib local: solo su package.json + dist (el runtime no necesita fuentes). La
# ruta replica el layout local para que `file:../../libs/structure-verifier`
# resuelva desde el WORKDIR del servicio.
COPY --from=libs structure-verifier/package.json /app/libs/structure-verifier/package.json
COPY --from=libs structure-verifier/dist /app/libs/structure-verifier/dist

WORKDIR /app/residguard_v2/residguard_ws

# Dependencias con lockfile congelado (build reproducible). pnpm-workspace.yaml
# trae allowBuilds (esbuild) para que el install no falle por scripts ignorados.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Recorta a dependencias de producción (fuera devDeps) para copiarlas tal cual.
RUN pnpm prune --prod

# ── Etapa 2: runtime ────────────────────────────────────────────────────────
FROM node:24-slim
# NODE_ENV=production: activa las validaciones fail-fast de config.ts
# (AUTH_WS_BASE_URL debe ser https) y desactiva tooling de desarrollo.
ENV NODE_ENV=production

# tini como PID 1: reenvía SIGTERM (server.ts cierra Fastify + pool de PG en
# orden) y cosecha zombies.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Mismos paths que la etapa de build: si pnpm dejó symlinks hacia la lib
# (dependencia file:), siguen resolviendo. Solo artefactos de runtime — sin
# fuentes, sin devDependencies, sin .env.
COPY --from=build /app/libs /app/libs
WORKDIR /app/residguard_v2/residguard_ws
COPY --from=build /app/residguard_v2/residguard_ws/node_modules ./node_modules
COPY --from=build /app/residguard_v2/residguard_ws/dist ./dist
COPY package.json ./

# El servicio escucha en 0.0.0.0:3004 por defecto (config: PORT).
EXPOSE 3004
USER node

# Healthcheck de LIVENESS (/health): ¿responde el proceso? No apunta a la BD
# para no reciclar el contenedor ante un blip de Postgres — ese chequeo lo hace
# la probe del orquestador.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3004)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
