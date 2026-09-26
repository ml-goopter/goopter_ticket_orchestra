# Worker service units

The worker runs natively on the host, never in compose (docs/design.md
§15.2, D16), because it spawns `git`, `gh`, `claude`, and `codex` and drives
each repository's own toolchain. This directory holds the two ways to run
it as a supervised service. Full operator instructions, including first-time
host setup and registering a project and repository, are in
`docs/runbook.md`.

## Which files

```
deploy/
  worker.env.example        template for .env.worker (every variable
                             apps/worker/src/config.ts reads)
  launchd/
    com.goopter.orchestra-worker.plist   LaunchAgent template (macOS)
    run-worker.sh                        loads .env.worker, execs node
    install.sh                           substitutes + bootstraps the agent
  systemd/
    orchestra-worker.service             user unit template (Linux)
    install.sh                           substitutes + enables the unit
```

## Common setup, both platforms

1. Build the worker from the repository root:

   ```sh
   corepack pnpm --filter @orchestra/worker build
   ```

2. Create the worker's own environment file:

   ```sh
   cp deploy/worker.env.example .env.worker
   ```

   `.env.worker` is a separate file from the compose `.env`, kept next to it
   at the repository root. It matches the `.env.*` pattern in `.gitignore`
   so it is never committed. It is separate on purpose: the systemd unit
   loads it with `EnvironmentFile=`, which — unlike bash — does not strip a
   trailing `# comment` from the end of a value line, so this template keeps
   every comment on its own line. Fill in every value; see
   `docs/runbook.md` for what each variable does.

## macOS (launchd)

```sh
deploy/launchd/install.sh
```

Resolves the checkout directory from the script's own location (override
with `--checkout-dir`), finds `git`, `gh`, `node`, `claude`, and `codex` on
the current `PATH` with `command -v` (warns and continues if `codex` is
missing — it is only needed for Codex repositories), substitutes those plus
the checkout path and a log directory into the plist template, copies it to
`~/Library/LaunchAgents/com.goopter.orchestra-worker.plist`, and runs
`launchctl bootstrap gui/$(id -u)`.

Logs land in `~/Library/Logs/orchestra-worker/`. Check status with
`launchctl print gui/$(id -u)/com.goopter.orchestra-worker`. Uninstall with
`deploy/launchd/install.sh --uninstall` (prints the `launchctl bootout`
command and removes the installed plist; it does not run `launchctl` for
you).

`ProgramArguments` points at `run-worker.sh` rather than
`pnpm --filter @orchestra/worker start`, because pnpm is only reachable in
this repository via `corepack pnpm` (see the repository's `CLAUDE.md`) and
launchd's restricted `PATH` should not have to resolve `corepack` and then
`pnpm` and then the workspace filter. `run-worker.sh` sources `.env.worker`
and execs `node apps/worker/dist/index.js` directly, relative to
`WorkingDirectory` (the checkout), which the plist also sets — launchd has
no `EnvironmentFile` key, which is why the wrapper exists at all.

## Linux (systemd, user unit)

```sh
deploy/systemd/install.sh
```

Same substitution as the launchd installer, plus resolving `node`'s full
path for `ExecStart`. Copies the unit to
`~/.config/systemd/user/orchestra-worker.service`, then runs
`systemctl --user daemon-reload` and `systemctl --user enable --now`.

Check status with `systemctl --user status orchestra-worker.service`, logs
with `journalctl --user -u orchestra-worker.service -f`. Uninstall with
`deploy/systemd/install.sh --uninstall`.

Unlike the launchd plist, this unit uses `EnvironmentFile=` directly against
`.env.worker`, since systemd unit files support that key natively.

If the worker must keep running after the operator logs out, enable
lingering once: `loginctl enable-linger "$USER"`.
