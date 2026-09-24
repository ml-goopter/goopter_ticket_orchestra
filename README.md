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

2. Build and start Postgres, the migration job, the api, and the web UI:

   ```sh
   docker compose up -d --build
   ```

3. Confirm the stack came up correctly:

   ```sh
   docker compose ps
   ```

   `db` should show `healthy`, `migrate` should show `Exited (0)` (it runs
   once and stops), and `api`/`web` should be running. `api` is currently a
   placeholder (design.md build order step 3 / GOT.18) and also exits
   immediately until it has a real Fastify server.

   Web is served at <http://localhost:8080>, proxying `/api/*` (including
   SSE streams) to the api container (`apps/web/nginx.conf`).

   If you only changed `apps/web` and want a fresh image without rebuilding
   everything else, run `docker compose build web` before `up`.

4. Tear down:

   ```sh
   docker compose down -v
   ```

### Worker

The worker is not a compose service — it runs on the host (design.md
§15.2, D16) so it can use the host's `git`, `gh`, `claude`, and `codex`
CLIs:

```sh
corepack pnpm --filter @orchestra/worker build
corepack pnpm --filter @orchestra/worker start
```

It needs `DATABASE_URL` pointed at the published Postgres port
(`postgres://<user>:<password>@localhost:5432/<db>` — see `.env.example`
for the container-vs-host distinction), plus the other worker variables
from `.env.example`. Run it under launchd (macOS) or systemd (Linux) with
restart on failure; requires `git`, `gh` (authenticated), `node` 22+,
`claude`, and `codex` (for Codex repositories) on `PATH`.

### Smoke test

`scripts/compose-smoke.sh` brings up `db` and `migrate` under a disposable
compose project, asserts migrate exits 0 and the `tasks` table exists, then
tears the stack down:

```sh
bash scripts/compose-smoke.sh
```
