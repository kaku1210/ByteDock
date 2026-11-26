#!/usr/bin/env bash
# Build, install, and manage T3 Code Plus from source on headless Linux servers
# (Ubuntu 24.04 LTS x86_64 / arm64, Debian, etc.).
#
# Usage:
#   bash scripts/install-linux-server.sh [--with-swap] [--no-service]
#
# Environment overrides:
#   T3CODE_REPO_URL         Git repository URL (default: https://github.com/kaku1210/t3code.git)
#   T3CODE_BRANCH           Git branch to track (default: develop)
#   T3CODE_SRC_DIR          Local source checkout directory (default: $HOME/t3code-plus)
#   T3CODE_HOME             T3 Code data directory (default: $HOME/.t3)
#   T3CODE_INSTALL_BIN_DIR  Where the `t3` wrapper goes (default: $HOME/.local/bin)
#   T3CODE_HOST             Server bind host (default: 127.0.0.1)
#   T3CODE_PORT             Server bind port (default: 3773)
#   T3CODE_BUILD_HEAP_MB    Node max-old-space-size during build (default: 3072)
#   T3CODE_RUNTIME_HEAP_MB  Node max-old-space-size at runtime (default: 1024)
#   T3CODE_SWAP_SIZE_GB     Swap size in GB when --with-swap is passed (default: 4)
#   T3CODE_SERVICE_NAME     systemd user unit name (default: t3code-plus.service)

set -euo pipefail

WITH_SWAP=0
INSTALL_SERVICE=1

for arg in "$@"; do
  case "$arg" in
    --with-swap) WITH_SWAP=1 ;;
    --no-service) INSTALL_SERVICE=0 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  printf 'This script is intended for Linux servers (detected: %s).\n' "$(uname -s)" >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  printf 'Do not run this script as root. Run it as your regular login user (e.g. ubuntu).\n' >&2
  exit 1
fi

REPO_URL="${T3CODE_REPO_URL:-https://github.com/kaku1210/t3code.git}"
BRANCH="${T3CODE_BRANCH:-develop}"
SRC_DIR="${T3CODE_SRC_DIR:-$HOME/t3code-plus}"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
BIN_DIR="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
BIND_HOST="${T3CODE_HOST:-127.0.0.1}"
BIND_PORT="${T3CODE_PORT:-3773}"
BUILD_HEAP_MB="${T3CODE_BUILD_HEAP_MB:-3072}"
RUNTIME_HEAP_MB="${T3CODE_RUNTIME_HEAP_MB:-1024}"
SWAP_SIZE_GB="${T3CODE_SWAP_SIZE_GB:-4}"
SERVICE_NAME="${T3CODE_SERVICE_NAME:-t3code-plus.service}"

info() { printf '\n==> %s\n' "$1"; }
warn() { printf '[warn] %s\n' "$1" >&2; }

ARCH="$(uname -m)"
KERNEL="$(uname -r)"
OS_PRETTY="Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_PRETTY="${PRETTY_NAME:-$OS_PRETTY}"
fi

info "Host inspection"
printf '  OS:     %s\n' "$OS_PRETTY"
printf '  Arch:   %s\n' "$ARCH"
printf '  Kernel: %s\n' "$KERNEL"

case "$ARCH" in
  x86_64|amd64|aarch64|arm64) ;;
  *) warn "Unverified architecture ($ARCH); continuing anyway." ;;
esac

for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Install it first (e.g. sudo apt-get install -y git curl).\n' "$cmd" >&2
    exit 1
  fi
done

MEM_KB="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)"
SWAP_KB="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)"
MEM_MB=$((MEM_KB / 1024))
SWAP_MB=$((SWAP_KB / 1024))
printf '  Memory: %s MB RAM, %s MB Swap\n' "$MEM_MB" "$SWAP_MB"

if [ "$WITH_SWAP" -eq 1 ] && [ "$SWAP_MB" -lt 1024 ]; then
  info "Creating ${SWAP_SIZE_GB}G swapfile (/swapfile)"
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "${SWAP_SIZE_GB}G" /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB * 1024))
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  fi
  sudo swapon /swapfile || true
  if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
elif [ "$MEM_MB" -le 4608 ] && [ "$SWAP_MB" -lt 2048 ]; then
  warn "Host has <= 4.5 GiB RAM and < 2 GiB swap. Source builds may OOM."
  warn "Re-run with --with-swap to create a ${SWAP_SIZE_GB}G swapfile automatically."
fi

info "Ensuring Vite+ (vp) is installed"
export PATH="$HOME/.vite-plus/bin:$HOME/.local/bin:$PATH"
if ! command -v vp >/dev/null 2>&1; then
  curl -fsSL https://vite.plus | bash
  export PATH="$HOME/.vite-plus/bin:$HOME/.local/bin:$PATH"
fi
if ! command -v vp >/dev/null 2>&1; then
  printf 'vp was installed but is still not on PATH. Open a new shell or add ~/.vite-plus/bin to PATH.\n' >&2
  exit 1
fi
printf '  vp: %s (%s)\n' "$(command -v vp)" "$(vp --version 2>/dev/null || echo unknown)"

info "Syncing T3 Code Plus source (${REPO_URL} @ ${BRANCH})"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch origin "$BRANCH"
  git -C "$SRC_DIR" checkout "$BRANCH"
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
else
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$SRC_DIR"
fi

info "Installing dependencies and building @t3tools/web + t3 server"
cd "$SRC_DIR"
NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB}" vp install
NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB}" vp run --filter t3 build

NODE_BIN="$(vp exec which node)"
SERVER_ENTRY="$SRC_DIR/apps/server/dist/bin.mjs"
if [ ! -f "$SERVER_ENTRY" ]; then
  printf 'Build finished but %s was not found.\n' "$SERVER_ENTRY" >&2
  exit 1
fi

info "Installing t3 CLI wrapper to ${BIN_DIR}/t3"
mkdir -p "$BIN_DIR" "$T3_HOME"
cat > "$BIN_DIR/t3" <<EOF
#!/usr/bin/env sh
set -eu
export T3CODE_HOME="\${T3CODE_HOME:-$T3_HOME}"
exec "$NODE_BIN" "$SERVER_ENTRY" "\$@"
EOF
chmod 755 "$BIN_DIR/t3"
printf '  Installed: %s (%s)\n' "$BIN_DIR/t3" "$("$BIN_DIR/t3" --version)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not in your shell PATH. Add this line to ~/.bashrc or ~/.profile:"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  info "Configuring systemd user service (${SERVICE_NAME})"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping systemd service setup."
    printf 'Start manually with: %s serve --host %s --port %s\n' "$BIN_DIR/t3" "$BIND_HOST" "$BIND_PORT"
    exit 0
  fi

  SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"
  SERVICE_ENV_FILE="$T3_HOME/service.env"
  if [ ! -f "$SERVICE_ENV_FILE" ]; then
    cat > "$SERVICE_ENV_FILE" <<EOF
T3CODE_HOST=$BIND_HOST
T3CODE_PORT=$BIND_PORT
# Uncomment if running headless Chrome previews where AppArmor blocks Chrome's sandbox:
# T3CODE_SERVER_BROWSER_SANDBOX=0
EOF
    chmod 600 "$SERVICE_ENV_FILE"
  fi

  cat > "$SERVICE_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=T3 Code Plus Server (from source)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SRC_DIR
Environment=NODE_ENV=production
Environment=T3CODE_HOME=$T3_HOME
Environment=T3CODE_HOST=$BIND_HOST
Environment=T3CODE_PORT=$BIND_PORT
Environment=NODE_OPTIONS=--max-old-space-size=$RUNTIME_HEAP_MB
EnvironmentFile=-$SERVICE_ENV_FILE
ExecStart=$NODE_BIN $SERVER_ENTRY serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"

  if command -v loginctl >/dev/null 2>&1; then
    LINGER_STATE="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)"
    if [ "$LINGER_STATE" != "yes" ]; then
      warn "systemd user lingering is disabled; the server will stop when you log out of SSH."
      warn "Enable it once with: sudo loginctl enable-linger \"$(id -un)\""
    fi
  fi

  info "Waiting for server health check (http://${BIND_HOST}:${BIND_PORT}/.well-known/t3/environment)"
  READY=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://${BIND_HOST}:${BIND_PORT}/.well-known/t3/environment" >/tmp/t3-env-probe.json 2>/dev/null; then
      READY=1
      break
    fi
    sleep 1
  done

  if [ "$READY" -eq 1 ]; then
    printf '  Server is healthy!\n'
    printf '  Descriptor: %s\n' "$(cat /tmp/t3-env-probe.json)"
    rm -f /tmp/t3-env-probe.json
  else
    warn "Server did not answer within 30s. Check logs with:"
    printf '  journalctl --user -u %s -n 50 --no-pager\n' "$SERVICE_NAME"
  fi
fi

info "Done!"
printf 'Next steps:\n'
printf '  1. Desktop SSH connect (zero public ports): Settings -> Environments -> Add environment -> SSH\n'
printf '     (Your desktop client will detect and reuse this running T3 Code Plus server automatically.)\n'
printf '  2. Direct pairing (for Caddy HTTPS or Tailscale): %s pair\n' "$BIN_DIR/t3"
printf '  3. Future updates: re-run this script anytime to git pull, rebuild, and restart.\n'
