#!/usr/bin/env bash
# Run a command against a repository inside a throwaway container that has
# no network, no keys and no way back to the host.
#
#   scripts/sandbox/run.sh <repo> [--with <dir>] -- <command...>
#
# What goes in: `git archive HEAD` of <repo> (tracked files only, so no .env,
# no data/, no wallet files, no untracked keys) plus, with --with, a directory
# of proof-of-concept files copied over it. Dependencies are installed while
# the image is built (network on, nothing secret in the context, install
# scripts off); the command itself then runs with:
#   --network none, every capability dropped, no-new-privileges, a read-only
#   root, an unprivileged user, a pid/memory/cpu ceiling and a wall-clock
#   timeout. Nothing from the host environment is passed in.
# The container and the image are deleted afterwards, whatever happened.
#
# Env: SANDBOX_IMAGE (default node:22-bookworm-slim), SANDBOX_SETUP (default
# `npm ci --ignore-scripts` when the repo has a package-lock.json),
# SANDBOX_TIMEOUT seconds (default 600).
set -euo pipefail

usage() { echo "usage: $0 <repo> [--with <dir>] -- <command...>" >&2; exit 2; }
[ $# -ge 3 ] || usage
repo=$(cd "$1" && pwd); shift
with=""
if [ "${1:-}" = "--with" ]; then with=$(cd "$2" && pwd); shift 2; fi
[ "${1:-}" = "--" ] || usage; shift
[ $# -gt 0 ] || usage

image_base=${SANDBOX_IMAGE:-node:22-bookworm-slim}
timeout_s=${SANDBOX_TIMEOUT:-600}
if [ -z "${SANDBOX_SETUP+x}" ]; then
  SANDBOX_SETUP=$([ -f "$repo/package-lock.json" ] && echo "npm ci --ignore-scripts --no-audit --no-fund" || echo "true")
fi

ctx=$(mktemp -d)
tag="lain-sandbox:$(date +%s)-$$"
cleanup() { rm -rf "$ctx"; docker rmi -f "$tag" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "$ctx/src"
git -C "$repo" archive HEAD | tar -x -C "$ctx/src"
[ -n "$with" ] && cp -a "$with/." "$ctx/src/"
cat > "$ctx/Dockerfile" <<DOCKER
FROM $image_base
WORKDIR /work
COPY src/ /work/
RUN $SANDBOX_SETUP && chown -R 1000:1000 /work
DOCKER

echo "[sandbox] building $tag from $(git -C "$repo" rev-parse --short HEAD)${with:+ + $with}" >&2
docker build -q -t "$tag" "$ctx" >/dev/null

echo "[sandbox] running offline: $*" >&2
set +e
timeout --kill-after=10 "$timeout_s" docker run --rm \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,size=256m \
  --user 1000:1000 \
  --pids-limit 256 --memory 2g --cpus 2 \
  --env HOME=/tmp \
  "$tag" "$@"
status=$?
set -e
echo "[sandbox] exit $status" >&2
exit $status
