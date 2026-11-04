# Lain OS as a container: the daemon (lain-serve) plus git and opencode for the forge.
#
# Built as is, the image runs the code it was built from. deploy/node/compose.yaml
# mounts a clone of this repo over /app instead, so what the forge commits survives
# a restart; the entrypoint installs and rebuilds before every start, exactly like
# the systemd unit's ExecStartPre. See README, "A node of your own".
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.19.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build && sha256sum package-lock.json | cut -c1-64 > node_modules/.lainos-lock

ENV NODE_ENV=production \
    LAINOS_HTTP_HOST=0.0.0.0 \
    LAINOS_HTTP_PORT=7777 \
    LAINOS_DATA_DIR=/app/data \
    LAINOS_WORKSPACE=/app/workspace
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD curl -fsS http://127.0.0.1:7777/health || exit 1
ENTRYPOINT ["tini", "--", "/app/deploy/node/entrypoint.sh"]
