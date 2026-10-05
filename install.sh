#!/bin/sh
# LainOS installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lain-labs/os/main/install.sh | sh
#   ./install.sh                    (from inside a checked-out LainOS repo)
#
# Env overrides (all optional):
#   LAINOS_REPO_URL   git URL to clone (default: https://github.com/lain-labs/os.git)
#   LAINOS_HOME       install root (default: $HOME/.lainos)
#   LAINOS_REF        git ref/branch to check out (default: main)
#
# This script never uses sudo and never touches a system Node install: it
# either uses a Node >=20 already on PATH, or downloads the official prebuilt
# tarball into $LAINOS_HOME/node.

set -eu

# The PATH this shell actually starts a new session with — captured before we
# temporarily prepend a privately-downloaded Node's bin dir below, so we can
# tell later whether a directory needs to be made *persistently* reachable
# (rc file) or is already on the user's real PATH.
ORIGINAL_PATH="$PATH"

LAINOS_HOME="${LAINOS_HOME:-$HOME/.lainos}"
LAINOS_REPO_URL="${LAINOS_REPO_URL:-https://github.com/lain-labs/os.git}"
LAINOS_REF="${LAINOS_REF:-main}"
NODE_MIN_MAJOR=20
NODE_PIN_VERSION="22.23.3" # used only when we fetch a tarball ourselves

log() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- detect os

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) die "unsupported OS '$OS_RAW' — this script supports macOS and Linux only (see install.ps1 for Windows)" ;;
esac

case "$ARCH_RAW" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) die "unsupported architecture '$ARCH_RAW'" ;;
esac

log "detected $OS/$ARCH"

# ------------------------------------------------------------- resolve node

node_major() {
  # $1: path to a node binary
  "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

NODE_BIN=""
NPM_BIN=""

if need node; then
  found_major="$(node_major "$(command -v node)")"
  if [ "$found_major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm)"
    log "using existing Node $(node -v) on PATH"
  else
    log "found Node $(node -v) on PATH, but LainOS needs >=$NODE_MIN_MAJOR — installing a private copy"
  fi
else
  log "no Node found on PATH — installing a private copy"
fi

if [ -z "$NODE_BIN" ]; then
  # Deliberately not going through Homebrew here: on a macOS version Homebrew
  # no longer ships a bottle for, `brew install node` falls back to compiling
  # Node (and its whole toolchain) from source, which can take a very long
  # time or exhaust memory on a modest machine. The official prebuilt tarball
  # below is the same binary a bottle would have installed, without that risk.
  NODE_DIR="$LAINOS_HOME/node"
  NODE_TARBALL_NAME="node-v${NODE_PIN_VERSION}-${OS}-${ARCH}"
  NODE_URL="https://nodejs.org/dist/v${NODE_PIN_VERSION}/${NODE_TARBALL_NAME}.tar.gz"
  if [ -x "$NODE_DIR/$NODE_TARBALL_NAME/bin/node" ]; then
    log "reusing previously downloaded Node at $NODE_DIR"
  else
    log "downloading Node v${NODE_PIN_VERSION} for $OS/$ARCH"
    mkdir -p "$NODE_DIR"
    TMP_TARBALL="$(mktemp -t lainos-node.XXXXXX).tar.gz"
    curl -fsSL -o "$TMP_TARBALL" "$NODE_URL" || die "failed to download $NODE_URL"
    tar -xzf "$TMP_TARBALL" -C "$NODE_DIR" || die "failed to extract Node tarball"
    rm -f "$TMP_TARBALL"
  fi
  NODE_BIN="$NODE_DIR/$NODE_TARBALL_NAME/bin/node"
  NPM_BIN="$NODE_DIR/$NODE_TARBALL_NAME/bin/npm"
  [ -x "$NODE_BIN" ] || die "Node download did not produce an executable at $NODE_BIN"
  PATH="$NODE_DIR/$NODE_TARBALL_NAME/bin:$PATH"
  export PATH
fi

FOUND_MAJOR="$(node_major "$NODE_BIN")"
if [ "$FOUND_MAJOR" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null; then
  die "resolved Node at $NODE_BIN is version $("$NODE_BIN" -v), but LainOS needs >=$NODE_MIN_MAJOR"
fi
log "Node ready: $("$NODE_BIN" -v) ($NODE_BIN)"

# ------------------------------------------------------------- resolve repo

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P || true)"

is_lainos_dir() {
  [ -f "$1/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"lainos"' "$1/package.json" 2>/dev/null
}

SRC_DIR=""
if [ -n "$SCRIPT_DIR" ] && is_lainos_dir "$SCRIPT_DIR"; then
  SRC_DIR="$SCRIPT_DIR"
  log "running from an existing LainOS checkout at $SRC_DIR"
elif is_lainos_dir "$(pwd)"; then
  SRC_DIR="$(pwd)"
  log "running from an existing LainOS checkout at $SRC_DIR"
else
  need git || die "git is required to fetch LainOS (no local checkout found and git is not on PATH)"
  APP_DIR="$LAINOS_HOME/app"
  if [ -d "$APP_DIR/.git" ]; then
    log "updating existing checkout at $APP_DIR"
    ( cd "$APP_DIR" && git fetch --depth 1 origin "$LAINOS_REF" \
        && git checkout -q "$LAINOS_REF" 2>/dev/null || true \
        && git reset -q --hard "origin/$LAINOS_REF" ) \
      || die "failed to update $APP_DIR — remove it and re-run to clone fresh"
  else
    log "cloning $LAINOS_REPO_URL into $APP_DIR"
    mkdir -p "$LAINOS_HOME"
    git clone --depth 1 --branch "$LAINOS_REF" "$LAINOS_REPO_URL" "$APP_DIR" \
      || die "git clone of $LAINOS_REPO_URL failed"
  fi
  SRC_DIR="$APP_DIR"
fi

cd "$SRC_DIR"

# ------------------------------------------------------------- build

log "installing dependencies (npm install)"
"$NPM_BIN" install || die "npm install failed in $SRC_DIR"

log "building LainOS (npm run build)"
"$NPM_BIN" run build || die "npm run build failed in $SRC_DIR"

# ------------------------------------------------------------- expose `lain`

# Whatever directory ends up holding the `lain` executable, make sure it is
# reachable from a *brand-new* shell — not just this script's own process,
# whose PATH may include a private Node bin dir we prepended above that never
# reaches the user's real shell. Idempotent: safe to call on every run.
persist_path_dir() {
  dir="$1"
  case ":$ORIGINAL_PATH:" in
    *":$dir:"*) return 0 ;; # already durably on PATH, nothing to do
  esac
  rc_file=""
  case "${SHELL:-}" in
    */zsh) rc_file="$HOME/.zshrc" ;;
    */bash) rc_file="$HOME/.bashrc" ;;
    *) rc_file="$HOME/.profile" ;;
  esac
  if ! grep -qs "$dir" "$rc_file" 2>/dev/null; then
    printf '\nexport PATH="%s:$PATH"\n' "$dir" >> "$rc_file"
    log "added $dir to PATH in $rc_file"
  fi
  NEEDS_NEW_SHELL=1
  NEW_SHELL_DIR="$dir"
}

NEEDS_NEW_SHELL=0
NEW_SHELL_DIR=""
LINKED=0
if "$NPM_BIN" link >/dev/null 2>&1; then
  LINKED_PATH="$(command -v lain 2>/dev/null || true)"
  if [ -n "$LINKED_PATH" ]; then
    LINKED=1
    log "linked the 'lain' command via npm link ($LINKED_PATH)"
    persist_path_dir "$(dirname "$LINKED_PATH")"
  fi
fi

if [ "$LINKED" -eq 0 ]; then
  log "npm link unavailable or not on PATH — installing wrapper scripts instead"
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  write_shim() {
    # $1: command name, $2: dist script it runs
    shim="$BIN_DIR/$1"
    cat > "$shim" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$SRC_DIR/dist/scripts/$2" "\$@"
EOF
    chmod +x "$shim"
    log "wrote $shim"
  }
  write_shim lain tui.js
  write_shim lain-cli chat.js
  write_shim lain-serve serve.js
  persist_path_dir "$BIN_DIR"
fi

# ------------------------------------------------------------- .env

if [ ! -f "$SRC_DIR/.env" ]; then
  cp "$SRC_DIR/.env.example" "$SRC_DIR/.env"
  log "created $SRC_DIR/.env from .env.example — edit it before running lain"
  log "at minimum, set an on-chain endpoint (CHAIN_RPC_URL, CHAIN_ID) and one model provider key (e.g. ANTHROPIC_API_KEY or OPENROUTER_API_KEY)"
else
  log "$SRC_DIR/.env already exists — leaving it as is"
fi

# ------------------------------------------------------------- Lain API key
#
# LainOS needs a model provider to actually answer anything. Lain OS
# (https://lain-os.com) is an OpenAI-compatible gateway with its own
# API keys and free signup credits, so it's the fastest path from "just
# installed" to "actually works" — prompt for one unless the operator has
# already configured *some* provider (their own OpenRouter/Anthropic key, or
# an explicit LAINOS_MODEL_PROVIDER for a subscription-CLI route).
prompt_lain_api_key() {
  if grep -qE '^(OPENROUTER_API_KEY|ANTHROPIC_API_KEY)=.+' "$SRC_DIR/.env" 2>/dev/null \
     || grep -qE '^LAINOS_MODEL_PROVIDER=.+' "$SRC_DIR/.env" 2>/dev/null; then
    return 0
  fi

  # `curl | sh` has no stdin of its own (that's the pipe), so we read from the
  # controlling terminal on fd 3 instead. Opening it can fail even when
  # /dev/tty exists (no controlling terminal at all, CI runners, etc.), and
  # POSIX makes a redirection error in a non-interactive shell fatal
  # unconditionally — `set +e`/`||`/`if` around the failing redirection
  # itself do NOT save it, it kills the whole script regardless. So the probe
  # happens in a subshell first: if *that* dies from the redirection error,
  # only the subshell exits, and its failure reaches us as an ordinary
  # non-zero status. Only once the probe succeeds do we open fd 3 for real in
  # this (parent) shell, where it's now known to work.
  if ! (exec 3< /dev/tty) 2>/dev/null; then
    log "non-interactive install — skipping API key setup"
    log "set OPENROUTER_API_KEY (and OPENROUTER_BASE_URL=https://lain-os.com/v1) in $SRC_DIR/.env before running lain"
    return 0
  fi
  exec 3< /dev/tty

  echo
  log "LainOS needs a model provider. Get a free Lain OS API key (with free signup credits) at:"
  log "  https://lain-os.com/register"
  log "opening it in your browser (if nothing opens, visit the link above yourself)…"
  echo
  if command -v open >/dev/null 2>&1; then
    open "https://lain-os.com/register" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "https://lain-os.com/register" >/dev/null 2>&1 &
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "https://lain-os.com/register" >/dev/null 2>&1 &
  fi

  key=""
  while true; do
    printf 'Paste your Lain API key (or type "skip" to set one up later): '
    set +e
    read -r key <&3
    read_ok=$?
    set -e
    if [ "$read_ok" -ne 0 ]; then
      echo
      log "no terminal input — skipping API key setup"
      exec 3<&- 2>/dev/null || true
      return 0
    fi
    case "$key" in
      skip|SKIP)
        log "skipped — set OPENROUTER_API_KEY / OPENROUTER_BASE_URL in $SRC_DIR/.env before running lain"
        exec 3<&- 2>/dev/null || true
        return 0
        ;;
      lain_*)
        break
        ;;
      "")
        echo 'no key entered.'
        ;;
      *)
        echo 'that does not look like a Lain API key (should start with "lain_"). Try again, or type "skip".'
        ;;
    esac
  done
  exec 3<&- 2>/dev/null || true

  tmp="$SRC_DIR/.env.tmp.$$"
  grep -vE '^(LAINOS_MODEL_PROVIDER|OPENROUTER_API_KEY|OPENROUTER_BASE_URL)=' "$SRC_DIR/.env" > "$tmp" 2>/dev/null || true
  {
    cat "$tmp"
    echo "LAINOS_MODEL_PROVIDER=openrouter"
    echo "OPENROUTER_API_KEY=$key"
    echo "OPENROUTER_BASE_URL=https://lain-os.com/v1"
  } > "$SRC_DIR/.env"
  rm -f "$tmp"

  log "saved your Lain API key to $SRC_DIR/.env — LainOS will use https://lain-os.com by default"
}

prompt_lain_api_key

# ------------------------------------------------------------- done

echo
log "LainOS is installed at $SRC_DIR"
log "next: edit $SRC_DIR/.env, then run: lain (TUI), lain-cli (REPL), or lain-serve (daemon)"

if [ "$NEEDS_NEW_SHELL" -eq 1 ]; then
  log "(open a new terminal, or run: export PATH=\"$NEW_SHELL_DIR:\$PATH\" — for 'lain' to be found in this one)"
fi
