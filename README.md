# goopter_ticket_orchestra

Control plane that turns Jira tickets into reviewed pull requests. See
`Orchestration-layer-spec.v1.md` for what it does and `docs/design.md` for
how it is built.

## First run

1. Copy the environment template and fill in secrets:

   ```sh
   cp .env.example .env
   ```

   `.env` is read by `docker compose` automatically and is git-ignored.
   Every variable is documented in `.env.example` (design.md §15.3).

   `SESSION_SECRET` ships as a placeholder that is too short to be valid;
   generate a real one before running the api:

   ```sh
   openssl rand -base64 48
   ```

   `NODE_ENV` defaults to `production`, which marks the session cookie
   `Secure`; set it to `development` in `.env` if you are logging in over
   plain `http://localhost` rather than TLS.

2. Build and start Postgres, the migration job, the api, and the web UI:

   ```sh
   docker compose up -d --build
   ```

3. Confirm the stack came up correctly:

   ```sh
   docker compose ps
   ```

   `db` should show `healthy`, `migrate` should show `Exited (0)` (it runs
   once and stops), and `api`/`web` should be running — `api` is a real
   Fastify server (`apps/api/src/index.ts`) that listens and serves auth,
   projects, repositories, tasks, and the other routes under `/api`.

   Web is served at <http://localhost:8080>, proxying `/api/*` (including
   SSE streams) to the api container (`apps/web/nginx.conf`).

   If you only changed `apps/web` and want a fresh image without rebuilding
   everything else, run `docker compose build web` before `up`.

4. Create the first user (there is no signup route, design D9):

   ```sh
   set -a; source .env; set +a
   corepack pnpm --filter @orchestra/api users:add jane@example.com --name "Jane Doe"
   ```

5. Tear down:

   ```sh
   docker compose down -v
   ```

For registering a project and a repository, and everything below, see
**`docs/runbook.md`** — the full operator runbook, including first-time
host setup, the worker as a service, token rotation, and worktree
maintenance.

### Worker

The worker is not a compose service — it runs on the host (design.md
§15.2, D16) so it can use the host's `git`, `gh`, `claude`, and `codex`
CLIs:

```sh
corepack pnpm --filter @orchestra/worker build
```

Run it under launchd (macOS) or systemd (Linux) with restart on failure
using the units and install scripts in `deploy/` — see `deploy/README.md`
for what each installer does and `docs/runbook.md` §6 for the full
walkthrough, including every environment variable the worker reads and
what a clean start logs.

### Smoke test

`scripts/compose-smoke.sh` brings up `db` and `migrate` under a disposable
compose project, asserts migrate exits 0 and the `tasks` table exists, then
tears the stack down:

```sh
bash scripts/compose-smoke.sh
```
