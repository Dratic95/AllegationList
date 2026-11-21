#!/usr/bin/env bash
# setup-server.sh - installs or updates the AllegationList bot on an Ubuntu server.
#
# Run it from an uploaded copy of the project (deploy.cmd does this for you):
#   sudo bash <uploaded project>/deploy/setup-server.sh
#
# Safe to run again for every update. It:
#   1. installs Node.js 24 if a new-enough version isn't there
#   2. creates the "allegationlist" system user (no login shell)
#   3. backs up the live data.json, then copies the new code into /opt/allegationlist
#      (data.json is only copied on the FIRST install; after that the server's copy is kept)
#   4. installs the npm dependencies
#   5. installs, enables and (re)starts the systemd service

set -euo pipefail

APP_DIR=/opt/allegationlist
SERVICE=allegationlist
SERVICE_USER=allegationlist
NODE_MAJOR=24          # the version the bot is developed and tested on
MIN_NODE_MAJOR=22      # --env-file needs 20.6+; stay on a supported LTS line
BACKUPS_TO_KEEP=5

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Re-run with sudo if needed (Oracle's "ubuntu" user has password-less sudo).
if [ "$(id -u)" -ne 0 ]; then exec sudo bash "$0" "$@"; fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC_DIR/index.js" ] || die "Can't find index.js next to the deploy folder ($SRC_DIR)."
[ -f "$SRC_DIR/package-lock.json" ] || die "package-lock.json is missing from the upload."
if [ ! -f "$SRC_DIR/.env" ] && [ ! -f "$APP_DIR/.env" ]; then
  die "No .env in the upload and none on the server yet. It holds the bot token; see DEPLOY.md."
fi

# --- 1. Node.js ------------------------------------------------------------------
current_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(current_major)" -lt "$MIN_NODE_MAJOR" ]; then
  say "Installing Node.js $NODE_MAJOR (from NodeSource)"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
say "Node.js $(node --version), npm $(npm --version)"

# --- 2. Service user -----------------------------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating system user $SERVICE_USER"
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- 3. Code and data ------------------------------------------------------------------
if systemctl is-active --quiet "$SERVICE"; then
  say "Stopping the running bot"
  systemctl stop "$SERVICE"
fi
mkdir -p "$APP_DIR"

if [ -f "$APP_DIR/data.json" ]; then
  backup="$APP_DIR/data.json.bak-$(date +%Y%m%d-%H%M%S)"
  say "Backing up data.json to $(basename "$backup")"
  cp -p "$APP_DIR/data.json" "$backup"
  # Keep only the newest few backups.
  ls -1t "$APP_DIR"/data.json.bak-* 2>/dev/null | tail -n +$((BACKUPS_TO_KEEP + 1)) | xargs -r rm -f
fi

say "Copying the code to $APP_DIR"
# Everything except installed packages and the data files, which belong to the server.
(cd "$SRC_DIR" && tar --exclude='./node_modules' --exclude='./data.json*' -cf - .) | (cd "$APP_DIR" && tar -xf -)

if [ ! -f "$APP_DIR/data.json" ] && [ -f "$SRC_DIR/data.json" ]; then
  say "First install: bringing over data.json from the upload"
  cp "$SRC_DIR/data.json" "$APP_DIR/data.json"
fi

# A .env saved on Windows can have CRLF line endings, which would put a stray "\r" on
# the end of the token.
sed -i 's/\r$//' "$APP_DIR/.env"

say "Installing dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 700 "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# --- 4. Service --------------------------------------------------------------------------
say "Installing and starting the $SERVICE service"
install -m 644 "$SRC_DIR/deploy/allegationlist.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# Give it a moment to log in, then show how it's doing.
sleep 10
if systemctl is-active --quiet "$SERVICE"; then
  say "The bot is running. Latest log lines:"
else
  say "The bot did NOT stay running. Latest log lines:"
fi
journalctl -u "$SERVICE" -n 15 --no-pager || true
systemctl is-active --quiet "$SERVICE"
