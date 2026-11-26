#!/usr/bin/env bash
# Cairn installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Jishnu-Prasad888/Cairn/main/scripts/install.sh | bash
#
# Pass options through bash:
#
#   curl -fsSL .../install.sh | bash -s -- --yes
#   curl -fsSL .../install.sh | bash -s -- --version v1.3.1
#   curl -fsSL .../install.sh | bash -s -- --uninstall
#
# Options (each also has an environment variable):
#   -y, --yes             Accept the default answer to every question  (CAIRN_YES=1)
#   -v, --version TAG     Install this release instead of the latest   (CAIRN_VERSION)
#   -d, --dir DIR         Install the binary into DIR                  (CAIRN_INSTALL_DIR)
#   -p, --port PORT       Port the service listens on (default 8715)   (CAIRN_PORT)
#       --no-service      Do not offer to set up a service
#       --uninstall       Remove the binary and the service (keeps your data)
#   -h, --help            Show this help
#
# The script never touches your photo libraries or the Cairn data directory.

set -euo pipefail

REPO="Jishnu-Prasad888/Cairn"
BIN_NAME="cairn"
SERVICE_NAME="cairn"

ASSUME_YES="${CAIRN_YES:-0}"
VERSION="${CAIRN_VERSION:-latest}"
INSTALL_DIR="${CAIRN_INSTALL_DIR:-}"
PORT="${CAIRN_PORT:-8715}"
OFFER_SERVICE=1
UNINSTALL=0

# --- output -----------------------------------------------------------------

if [ -t 2 ]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m' C_RESET=$'\033[0m'
else
  C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_RESET=""
fi

info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*" >&2; }
ok()   { printf '%s ✓ %s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
warn() { printf '%s !  %s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF_USAGE'
Usage: install.sh [options]

  -y, --yes             Accept the default answer to every question  (CAIRN_YES=1)
  -v, --version TAG     Install this release instead of the latest   (CAIRN_VERSION)
  -d, --dir DIR         Install the binary into DIR                  (CAIRN_INSTALL_DIR)
  -p, --port PORT       Port the service listens on (default 8715)   (CAIRN_PORT)
      --no-service      Do not offer to set up a service
      --uninstall       Remove the binary and the service (keeps your data)
  -h, --help            Show this help
EOF_USAGE
}

# --- arguments --------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)      ASSUME_YES=1 ;;
    -v|--version)  VERSION="${2:?--version needs a tag}"; shift ;;
    -d|--dir)      INSTALL_DIR="${2:?--dir needs a directory}"; shift ;;
    -p|--port)     PORT="${2:?--port needs a number}"; shift ;;
    --no-service)  OFFER_SERVICE=0 ;;
    --uninstall)   UNINSTALL=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

case "$PORT" in
  ''|*[!0-9]*) die "port must be a number, got '$PORT'" ;;
esac

# --- prompts ----------------------------------------------------------------
# When piped into bash, stdin is the script itself, so questions are read from
# the terminal. Without a terminal (CI, provisioning) the defaults are used.

if [ "$ASSUME_YES" != "1" ] && { exec 3</dev/tty; } 2>/dev/null; then
  HAVE_TTY=1
else
  HAVE_TTY=0
fi

# ask "Question" y|n  -> returns 0 for yes, 1 for no
ask() {
  local question="$1" default="$2" hint reply
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$HAVE_TTY" != "1" ]; then
    printf '%s?%s %s %s %s%s%s\n' "$C_BOLD" "$C_RESET" "$question" "$hint" "$C_DIM" "$default (default)" "$C_RESET" >&2
    [ "$default" = "y" ]
    return
  fi
  while true; do
    printf '%s?%s %s %s ' "$C_BOLD" "$C_RESET" "$question" "$hint" >&2
    IFS= read -r reply <&3 || reply=""
    case "${reply:-$default}" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
      *) printf '   Please answer y or n.\n' >&2 ;;
    esac
  done
}

# --- helpers ----------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif have sudo; then
  SUDO="sudo"
else
  SUDO=""
fi

# as_root runs a command as root, or fails clearly when that is impossible.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif [ -n "$SUDO" ]; then
    sudo "$@"
  else
    die "this step needs root and sudo is not available: $*"
  fi
}

# fetch URL [OUTPUT]  -- download to a file, or to stdout without OUTPUT.
fetch() {
  local url="$1" out="${2:-}"
  if have curl; then
    if [ -n "$out" ]; then
      curl -fL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 30 --progress-bar -o "$out" "$url"
    else
      curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 60 "$url"
    fi
  elif have wget; then
    if [ -n "$out" ]; then
      wget -q -T 30 -O "$out" "$url"
    else
      wget -q -T 30 -O- "$url"
    fi
  else
    die "curl or wget is required"
  fi
}

# latest_tag resolves the newest release tag by following GitHub's
# /releases/latest redirect, which avoids the API's rate limit.
latest_tag() {
  local url
  if have curl; then
    url="$(curl -fsSLI --connect-timeout 15 --max-time 30 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  else
    url="$(wget -S --spider "https://github.com/$REPO/releases/latest" 2>&1 | awk '/^  Location: /{l=$2} END{print l}')"
  fi
  url="${url%$'\r'}"
  case "$url" in
    */releases/tag/*) printf '%s\n' "${url##*/}" ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

has_systemd() { [ -d /run/systemd/system ] && have systemctl; }

wait_for_health() {
  local i
  have curl || return 0
  for i in $(seq 1 20); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# --- platform detection -----------------------------------------------------

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      die "on Windows, run the PowerShell installer instead:
  irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1 | iex" ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7*|armv6*|armhf|i386|i686)
      die "unsupported CPU: $(uname -m). Cairn needs a 64-bit CPU (amd64 or arm64).
On a Raspberry Pi, install a 64-bit OS (see docs/raspberry-pi.md)." ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac

  # A shell running under Rosetta reports x86_64 on Apple Silicon.
  if [ "$os" = "darwin" ] && [ "$arch" = "amd64" ] \
    && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi

  OS="$os"
  ARCH="$arch"
}

choose_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    return
  fi
  if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
    warn "sudo is not available; installing into $INSTALL_DIR"
  fi
}

# needs_root DIR -- whether writing into DIR needs root.
needs_root() {
  local dir="$1"
  while [ ! -d "$dir" ]; do dir="$(dirname "$dir")"; done
  [ ! -w "$dir" ]
}

# The account the service runs as by default: the person who ran the
# installer, even when they ran it through sudo.
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(eval echo "~$TARGET_USER" 2>/dev/null || echo "$HOME")"

# --- uninstall --------------------------------------------------------------

uninstall() {
  info "Uninstalling Cairn"
  if has_systemd && [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    as_root systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    as_root rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    as_root systemctl daemon-reload
    ok "Removed the systemd service"
  fi
  local plist="$TARGET_HOME/Library/LaunchAgents/com.cairn.server.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$(id -u "$TARGET_USER")" "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "Removed the launchd agent"
  fi
  local path
  for path in "${INSTALL_DIR:-/usr/local/bin}/$BIN_NAME" "$HOME/.local/bin/$BIN_NAME"; do
    if [ -f "$path" ]; then
      if needs_root "$(dirname "$path")"; then as_root rm -f "$path"; else rm -f "$path"; fi
      ok "Removed $path"
    fi
  done
  info "Your data directory and libraries were left untouched."
  exit 0
}

[ "$UNINSTALL" = "1" ] && uninstall

# --- download & install -----------------------------------------------------

detect_platform
choose_install_dir

printf '\n%sCairn installer%s\n\n' "$C_BOLD" "$C_RESET" >&2
info "Detected $OS/$ARCH"

if [ "$VERSION" = "latest" ]; then
  VERSION="$(latest_tag)" || die "could not determine the latest release of $REPO"
fi
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
info "Release $VERSION"

ASSET="cairn-$OS-$ARCH"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading $ASSET"
fetch "$BASE_URL/$ASSET" "$TMP_DIR/$ASSET" || die "download failed: $BASE_URL/$ASSET"

# Verify against SHA256SUMS. Entries may carry a path prefix (dist/cairn-...),
# so match on the file name.
if fetch "$BASE_URL/SHA256SUMS" > "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
  expected="$(awk -v f="$ASSET" '{n=$2; sub(/^\*/, "", n); sub(/.*\//, "", n); if (n == f) print $1}' "$TMP_DIR/SHA256SUMS")"
  if [ -z "$expected" ]; then
    die "$ASSET is not listed in SHA256SUMS"
  fi
  actual="$(sha256_of "$TMP_DIR/$ASSET")" || die "sha256sum or shasum is required to verify the download"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $ASSET (expected $expected, got $actual)"
  ok "Checksum verified"
else
  warn "SHA256SUMS not found in $VERSION; skipping checksum verification"
fi

chmod 0755 "$TMP_DIR/$ASSET"
# Releases downloaded with curl carry no quarantine flag, but clear it anyway.
[ "$OS" = "darwin" ] && xattr -d com.apple.quarantine "$TMP_DIR/$ASSET" 2>/dev/null || true

DEST="$INSTALL_DIR/$BIN_NAME"
UPGRADE=0
[ -f "$DEST" ] && UPGRADE=1

if needs_root "$INSTALL_DIR"; then
  as_root mkdir -p "$INSTALL_DIR"
  as_root install -m 0755 "$TMP_DIR/$ASSET" "$DEST"
else
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$TMP_DIR/$ASSET" "$DEST"
fi
if [ "$UPGRADE" = "1" ]; then ok "Upgraded $DEST to $VERSION"; else ok "Installed $DEST"; fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it with:
      echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile" ;;
esac

# --- ffmpeg -----------------------------------------------------------------

if ! have ffmpeg; then
  warn "ffmpeg was not found. Cairn uses it for video, HEIC and AVIF thumbnails."
  pm_cmd=""
  if   [ "$OS" = "darwin" ] && have brew; then pm_cmd="brew install ffmpeg"
  elif have apt-get; then pm_cmd="as_root apt-get update -qq && as_root apt-get install -y ffmpeg"
  elif have dnf;     then pm_cmd="as_root dnf install -y ffmpeg"
  elif have pacman;  then pm_cmd="as_root pacman -S --noconfirm ffmpeg"
  elif have zypper;  then pm_cmd="as_root zypper --non-interactive install ffmpeg"
  elif have apk;     then pm_cmd="as_root apk add ffmpeg"
  fi
  if [ -n "$pm_cmd" ]; then
    if ask "Install ffmpeg now?" y; then
      if eval "$pm_cmd"; then ok "ffmpeg installed"; else warn "ffmpeg install failed; install it later yourself"; fi
    fi
  else
    warn "Install ffmpeg with your package manager to get video thumbnails."
  fi
fi

# --- service ----------------------------------------------------------------

LISTEN_ADDR="127.0.0.1:$PORT"

choose_listen_addr() {
  if ask "Allow other devices on your network to reach Cairn (listen on 0.0.0.0:$PORT)?" n; then
    LISTEN_ADDR="0.0.0.0:$PORT"
    warn "Cairn serves plain HTTP. For access beyond your LAN, put a TLS reverse proxy in front (docs/deployment.md)."
  fi
}

setup_systemd() {
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  local run_user run_group data_dir

  if [ -f "$unit" ]; then
    if [ "$UPGRADE" = "1" ] && ! ask "A Cairn service already exists. Rewrite its configuration?" n; then
      if as_root systemctl is-active --quiet "$SERVICE_NAME"; then
        as_root systemctl restart "$SERVICE_NAME"
        ok "Restarted the $SERVICE_NAME service on $VERSION"
      fi
      return
    fi
  fi

  if ! ask "Set up a systemd service so Cairn starts automatically at boot?" y; then
    return
  fi

  if [ "$TARGET_USER" != "root" ] && ask "Run the service as '$TARGET_USER' (so it can read your existing photo folders)?" y; then
    run_user="$TARGET_USER"
    run_group="$(id -gn "$TARGET_USER")"
    data_dir="$TARGET_HOME/.local/share/cairn"
    if [ "$(id -un)" = "$run_user" ]; then
      mkdir -p "$data_dir"
    else
      as_root sudo -u "$run_user" mkdir -p "$data_dir"
    fi
  else
    run_user="cairn"
    run_group="cairn"
    data_dir="/var/lib/cairn"
    if ! id "$run_user" >/dev/null 2>&1; then
      local nologin
      nologin="$(command -v nologin || echo /bin/false)"
      as_root useradd --system --user-group --home-dir "$data_dir" --shell "$nologin" "$run_user"
      ok "Created system user '$run_user'"
    fi
    as_root install -d -m 0750 -o "$run_user" -g "$run_group" "$data_dir"
    warn "The '$run_user' user needs read/write access to every library folder you add, e.g.:
      sudo setfacl -R -m u:cairn:rwX -m d:u:cairn:rwX /path/to/photos"
  fi

  choose_listen_addr

  as_root tee "$unit" >/dev/null <<EOF
[Unit]
Description=Cairn media server
Documentation=https://github.com/$REPO
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$run_group
Environment=CAIRN_DATA_DIR=$data_dir
Environment=CAIRN_HTTP_ADDR=$LISTEN_ADDR
ExecStart=$DEST
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
  ok "Wrote $unit"

  as_root systemctl daemon-reload
  if ask "Start Cairn now?" y; then
    as_root systemctl enable --now "$SERVICE_NAME"
    as_root systemctl restart "$SERVICE_NAME"
    if wait_for_health; then
      ok "Cairn is running"
    else
      warn "Cairn did not answer yet. Check: sudo journalctl -u $SERVICE_NAME -e"
    fi
  else
    as_root systemctl enable "$SERVICE_NAME"
    ok "Enabled; Cairn will start at next boot (or: sudo systemctl start $SERVICE_NAME)"
  fi

  SERVICE_HINT="  Status:  sudo systemctl status $SERVICE_NAME
  Logs:    sudo journalctl -u $SERVICE_NAME -f
  Data:    $data_dir"
}

setup_launchd() {
  local label="com.cairn.server"
  local agents="$HOME/Library/LaunchAgents"
  local plist="$agents/$label.plist"
  local data_dir="$HOME/.local/share/cairn"
  local log_dir="$HOME/Library/Logs/Cairn"

  if [ "$(id -u)" -eq 0 ]; then
    warn "Run the installer as your own user (not root) to set up the launchd agent."
    return
  fi

  if [ -f "$plist" ] && [ "$UPGRADE" = "1" ] && ! ask "A Cairn launch agent already exists. Rewrite it?" n; then
    launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null && ok "Restarted Cairn on $VERSION"
    return
  fi

  if ! ask "Start Cairn automatically when you log in (launchd agent)?" y; then
    return
  fi
  choose_listen_addr

  mkdir -p "$agents" "$data_dir" "$log_dir"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$DEST</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CAIRN_DATA_DIR</key><string>$data_dir</string>
    <key>CAIRN_HTTP_ADDR</key><string>$LISTEN_ADDR</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$log_dir/cairn.log</string>
  <key>StandardErrorPath</key><string>$log_dir/cairn.log</string>
</dict>
</plist>
EOF
  ok "Wrote $plist"

  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  if wait_for_health; then ok "Cairn is running"; else warn "Cairn did not answer yet. Check $log_dir/cairn.log"; fi

  SERVICE_HINT="  Restart: launchctl kickstart -k gui/\$(id -u)/$label
  Logs:    $log_dir/cairn.log
  Data:    $data_dir"
}

SERVICE_HINT=""
if [ "$OFFER_SERVICE" = "1" ]; then
  if [ "$OS" = "linux" ]; then
    if has_systemd; then
      setup_systemd
    else
      warn "systemd is not running here; skipping service setup."
    fi
  elif [ "$OS" = "darwin" ]; then
    setup_launchd
  fi
fi

# --- done -------------------------------------------------------------------

host="127.0.0.1"
[ "${LISTEN_ADDR%%:*}" = "0.0.0.0" ] && host="$(hostname 2>/dev/null || echo localhost)"

printf '\n%sCairn %s is installed.%s\n\n' "$C_GREEN$C_BOLD" "$VERSION" "$C_RESET" >&2
if [ -n "$SERVICE_HINT" ]; then
  printf '  Open:    http://%s:%s\n%s\n\n' "$host" "$PORT" "$SERVICE_HINT" >&2
else
  printf '  Run it:  %s\n  Open:    http://127.0.0.1:%s\n\n' "$BIN_NAME" "$PORT" >&2
fi
printf '  On first visit you will create the admin account.\n' >&2
printf '  Upgrade by running this installer again.\n\n' >&2
