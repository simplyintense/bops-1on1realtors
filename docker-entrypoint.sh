#!/bin/sh
# Fly volume files can end up root-owned after `fly ssh` (root by default). The app runs as
# bops and then gets EACCES on posts.jsonl and similar. This script, running as root at
# container start, gives those files back to bops (skipping ext4's lost+found) and drops
# privileges before exec'ing the server.
set -e

DATA_DIR="${BOPS_DATA_DIR:-/app/.data}"
APP_USER="${BOPS_USER:-bops}"
APP_GROUP="${BOPS_GROUP:-bops}"

list_owned() {
  dir=$1
  from=${2:-0}
  [ -d "$dir" ] || return 0
  find "$dir" -path "$dir/lost+found" -prune -o -user "$from" -print
}

fix_ownership() {
  dir=$1
  [ -d "$dir" ] || return 0
  find "$dir" -path "$dir/lost+found" -prune -o -user 0 -exec chown "$APP_USER:$APP_GROUP" {} +
}

if [ "${1:-}" = "--list-owned" ]; then
  # Usage: docker-entrypoint.sh --list-owned <dir> [uid]
  list_owned "${2:-$DATA_DIR}" "${3:-0}"
  exit 0
fi

if [ "${1:-}" = "--fix-ownership-only" ]; then
  fix_ownership "${2:-$DATA_DIR}"
  exit 0
fi

if [ "$(id -u)" = "0" ]; then
  fix_ownership "$DATA_DIR"
  exec gosu "$APP_USER" "$@"
fi

exec "$@"
