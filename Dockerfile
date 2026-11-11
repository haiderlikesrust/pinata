# syntax=docker/dockerfile:1
# One Node server: the site, the API, the websocket and the payout bot. Dokploy runs it as a Swarm
# service and updates it start-first, so the new version is up before the old one stops (docs/DOKPLOY.md).
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY shared shared
COPY web web
RUN npm run build -w web

# Only what the server needs at runtime: no React, three.js or build tools.
FROM node:24-bookworm-slim AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --include-workspace-root --no-audit --no-fund

FROM node:24-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/pinata.sqlite STATIC_DIR=/app/web/dist
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-dependencies --chown=node:node /app/server ./server
COPY --chown=node:node package.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node server/tsconfig.json ./server/
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node server/scripts ./server/scripts
COPY --from=build --chown=node:node /app/web/dist ./web/dist
# The database and the hand-over lock live here. Mount a Dokploy volume on it (docs/DOKPLOY.md, step 5).
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
# "standby" counts as healthy: during an update the new server waits for the old one to hand over.
HEALTHCHECK --interval=5s --timeout=3s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# node is PID 1 so it receives SIGTERM itself and can hand over cleanly.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
