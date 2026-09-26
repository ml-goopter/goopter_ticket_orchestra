#!/usr/bin/env bash
# Installs (or removes) the orchestra worker systemd user unit (docs/design.md
# §15.2). Mirrors deploy/launchd/install.sh: substitutes the checkout path,
# the resolved `node` binary, and a PATH built from
# `which git gh node claude codex` into the unit template, copies the result
# to ~/.config/systemd/user, and enables + starts it.
#
# Usage:
#   deploy/systemd/install.sh [--checkout-dir DIR]
#   deploy/systemd/install.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="orchestra-worker.service"
UNIT_TEMPLATE="$SCRIPT_DIR/${UNIT_NAME}"
UNIT_DEST_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DEST_DIR/${UNIT_NAME}"

CHECKOUT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout-dir)
      CHECKOUT_DIR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  echo "To stop and disable the unit, run:"
  echo "  systemctl --user disable --now ${UNIT_NAME}"
  echo "Then remove the installed file and reload:"
  echo "  rm -f \"$UNIT_DEST\""
  echo "  systemctl --user daemon-reload"
  exit 0
fi

if [ ! -f "$CHECKOUT_DIR/apps/worker/dist/index.js" ]; then
  echo "warning: $CHECKOUT_DIR/apps/worker/dist/index.js not found." >&2
  echo "Build it first: corepack pnpm --filter @orchestra/worker build" >&2
fi

if [ ! -f "$CHECKOUT_DIR/.env.worker" ]; then
  echo "warning: $CHECKOUT_DIR/.env.worker not found." >&2
  echo "Copy the template first: cp deploy/worker.env.example .env.worker" >&2
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: 'node' not found on PATH; cannot install the unit." >&2
  exit 1
fi

# Directories holding each binary the worker or the agents it spawns need on
# PATH (docs/design.md §15.2). `codex` is optional (Codex repositories only).
# Verify with `which git gh node claude codex` if this list looks wrong for
# this host.
PATH_DIRS=""
for bin in git gh node claude codex; do
  found="$(command -v "$bin" 2>/dev/null || true)"
  if [ -z "$found" ]; then
    echo "warning: '$bin' not found on the current PATH; the worker will not be able to use it." >&2
    continue
  fi
  dir="$(dirname "$found")"
  case ":$PATH_DIRS:" in
    *":$dir:"*) ;;
    *) PATH_DIRS="${PATH_DIRS:+$PATH_DIRS:}$dir" ;;
  esac
done
PATH_DIRS="${PATH_DIRS:+$PATH_DIRS:}/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$UNIT_DEST_DIR"

sed \
  -e "s#__CHECKOUT_DIR__#${CHECKOUT_DIR}#g" \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  -e "s#__PATH__#${PATH_DIRS}#g" \
  "$UNIT_TEMPLATE" > "$UNIT_DEST"

echo "Installed $UNIT_DEST"
echo "PATH baked into the unit: $PATH_DIRS"

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"

echo
echo "Started. Check status with:"
echo "  systemctl --user status ${UNIT_NAME}"
echo "Logs:"
echo "  journalctl --user -u ${UNIT_NAME} -f"
echo
echo "To uninstall: $0 --uninstall"
