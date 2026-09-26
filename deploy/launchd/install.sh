#!/usr/bin/env bash
# Installs (or removes) the orchestra worker LaunchAgent (docs/design.md
# §15.2). Substitutes the checkout path, a log directory, and a PATH built
# from `which git gh node claude codex` into the plist template, copies the
# result to ~/Library/LaunchAgents, and bootstraps it.
#
# Usage:
#   deploy/launchd/install.sh [--checkout-dir DIR]
#   deploy/launchd/install.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.goopter.orchestra-worker"
PLIST_TEMPLATE="$SCRIPT_DIR/com.goopter.orchestra-worker.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/orchestra-worker"

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
  echo "To stop and unload the agent, run:"
  echo "  launchctl bootout gui/\$(id -u)/${LABEL}"
  echo "Then remove the installed files:"
  echo "  rm -f \"$PLIST_DEST\""
  echo "Logs are left in place at $LOG_DIR; remove them manually if wanted."
  exit 0
fi

if [ ! -x "$CHECKOUT_DIR/apps/worker/dist/index.js" ] && [ ! -f "$CHECKOUT_DIR/apps/worker/dist/index.js" ]; then
  echo "warning: $CHECKOUT_DIR/apps/worker/dist/index.js not found." >&2
  echo "Build it first: corepack pnpm --filter @orchestra/worker build" >&2
fi

if [ ! -f "$CHECKOUT_DIR/.env.worker" ]; then
  echo "warning: $CHECKOUT_DIR/.env.worker not found." >&2
  echo "Copy the template first: cp deploy/worker.env.example .env.worker" >&2
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
# Always include the standard system directories so coreutils resolve too.
PATH_DIRS="${PATH_DIRS:+$PATH_DIRS:}/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_DEST")"

sed \
  -e "s#__CHECKOUT_DIR__#${CHECKOUT_DIR}#g" \
  -e "s#__LOG_DIR__#${LOG_DIR}#g" \
  -e "s#__PATH__#${PATH_DIRS}#g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"

chmod +x "$SCRIPT_DIR/run-worker.sh"

echo "Installed $PLIST_DEST"
echo "PATH baked into the agent: $PATH_DIRS"

launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo
echo "Bootstrapped. Check status with:"
echo "  launchctl print gui/\$(id -u)/${LABEL}"
echo "Logs:"
echo "  tail -f \"$LOG_DIR/orchestra-worker.out.log\" \"$LOG_DIR/orchestra-worker.err.log\""
echo
echo "To uninstall: $0 --uninstall"
