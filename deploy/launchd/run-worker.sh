#!/usr/bin/env bash
# Wrapper launchd execs instead of node directly (docs/design.md §15.2).
#
# launchd's LaunchAgent plist has no `EnvironmentFile` key, so this script
# loads .env.worker (see deploy/worker.env.example) into the process
# environment before starting the worker. It has no placeholders: the plist
# sets WorkingDirectory to the repository checkout, and launchd runs this
# script with that as its current directory, so both the env file and the
# built worker are found by relative path.
#
# Runs `node apps/worker/dist/index.js` directly rather than
# `pnpm --filter @orchestra/worker start` so this does not depend on pnpm
# (only reachable here via `corepack pnpm`, see CLAUDE.md) being resolvable
# from launchd's restricted PATH.
set -euo pipefail

if [ -f ./.env.worker ]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env.worker
  set +a
fi

exec node apps/worker/dist/index.js
