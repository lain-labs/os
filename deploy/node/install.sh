#!/usr/bin/env bash
# Set up or update a Lain node next to a validator: the node-API socket, the
# node directory with its secrets, and Lain OS + Hermes + OpenClaw in rootless
# Docker. Idempotent. Run as root, from the clone at /home/<user>/lain-node/lainos:
#
#   OPENROUTER_API_KEY=sk-or-… CHAOS_MCP_KEY=lain_… bash deploy/node/install.sh
#
# Both keys are read from the environment only on the first install (or while a
# secrets file still has the placeholder); every bearer between the containers is
# generated here and never printed.
set -euo pipefail

USER_NAME=${LAIN_NODE_USER:-lain}
NODE_DIR=/home/$USER_NAME/lain-node
HERE=$NODE_DIR/lainos/deploy/node
UID_N=$(id -u "$USER_NAME")
as_user() {
  runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR=/run/user/$UID_N DOCKER_HOST=unix:///run/user/$UID_N/docker.sock "$@"
}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$HERE/compose.yaml" ] || { echo "no clone at $NODE_DIR/lainos" >&2; exit 1; }

# 1. The validator's API, as a socket the containers can mount.
install -m 0644 "$HERE/fuji-rpc.socket" "$HERE/fuji-rpc.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fuji-rpc.socket

# 2. The node directory. Agent configs are seeded once; after that they are the agents' own.
as_user mkdir -p "$NODE_DIR/secrets" "$NODE_DIR/hermes" "$NODE_DIR/openclaw"
chmod 700 "$NODE_DIR/secrets"
as_user cp "$HERE/compose.yaml" "$NODE_DIR/compose.yaml"
first_hermes=0
if [ ! -e "$NODE_DIR/hermes/config.yaml" ]; then
  as_user cp -r "$HERE/hermes/." "$NODE_DIR/hermes/"
  first_hermes=1
fi
[ -e "$NODE_DIR/openclaw/openclaw.json" ] || as_user cp "$HERE/openclaw/openclaw.json" "$NODE_DIR/openclaw/"

# 3. Secrets: copied from the templates, bearers generated, the two outside keys filled in.
set_env() { # file key value — replace the key's line, keeping the file 0600
  local file=$1 key=$2 value=$3
  if grep -q "^$key=" "$file"; then sed -i "s|^$key=.*|$key=$value|" "$file"; else echo "$key=$value" >>"$file"; fi
}
placeholder() { grep -Eq "^$2=(…|sk-or-…|lain_…)?$" "$1"; }
for name in lainos hermes openclaw; do
  f=$NODE_DIR/secrets/$name.env
  [ -e "$f" ] || as_user install -m 0600 "$HERE/$name.env.example" "$f"
  for key in OPENROUTER_API_KEY CHAOS_MCP_KEY; do
    if grep -q "^$key=" "$f" && placeholder "$f" "$key" && [ -n "${!key:-}" ]; then set_env "$f" "$key" "${!key}"; fi
  done
done
L=$NODE_DIR/secrets/lainos.env H=$NODE_DIR/secrets/hermes.env O=$NODE_DIR/secrets/openclaw.env
placeholder "$L" LAINOS_HTTP_KEY && set_env "$L" LAINOS_HTTP_KEY "$(openssl rand -hex 32)"
if placeholder "$H" API_SERVER_KEY; then k=$(openssl rand -hex 32); set_env "$H" API_SERVER_KEY "$k"; set_env "$L" LAINOS_SUBAGENT_HERMES_KEY "$k"; fi
if placeholder "$O" OPENCLAW_GATEWAY_TOKEN; then k=$(openssl rand -hex 32); set_env "$O" OPENCLAW_GATEWAY_TOKEN "$k"; set_env "$L" LAINOS_SUBAGENT_OPENCLAW_KEY "$k"; fi
for f in "$L" "$H" "$O"; do
  # sed -i writes a new file as root: give it back to the user, still 0600.
  chown "$USER_NAME:" "$f" && chmod 600 "$f"
  for key in OPENROUTER_API_KEY CHAOS_MCP_KEY; do
    grep -q "^$key=" "$f" && placeholder "$f" "$key" && echo "warning: $key is not set in $f" >&2
  done
done

# 4. OpenClaw runs as `node` (uid 1000 inside); its state must be that user's.
image_oc=$(sed -n 's|^ *image: \(ghcr.io/openclaw/openclaw@.*\)|\1|p' "$NODE_DIR/compose.yaml")
as_user docker run --rm -u 0 --entrypoint chown -v "$NODE_DIR/openclaw:/d" "$image_oc" -R 1000:1000 /d

# 5. Build Lain's image and (re)start the three.
cd "$NODE_DIR"
as_user docker compose build lainos
as_user docker compose up -d
[ "$first_hermes" = 1 ] && echo "hermes: config and skills seeded from $HERE/hermes"
as_user docker compose ps
