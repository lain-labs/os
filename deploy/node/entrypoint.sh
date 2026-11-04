#!/bin/sh
# Start the daemon from /app the way the systemd unit does: install when the
# lockfile changed, rebuild, run. A forge self-upgrade exits non-zero, and the
# container's restart policy brings it back through here onto the new code.
set -e
cd /app
lock=$(sha256sum package-lock.json | cut -c1-64)
if [ "$(cat node_modules/.lainos-lock 2>/dev/null)" != "$lock" ]; then
  npm ci --include=dev --no-audit --no-fund
  echo "$lock" > node_modules/.lainos-lock
fi
npm run build
mkdir -p "${LAINOS_DATA_DIR:-/app/data}" "${LAINOS_WORKSPACE:-/app/workspace}"
exec node --enable-source-maps dist/scripts/serve.js
