# Operator runbook

Companion to `docs/design.md` §15 (deployment and configuration). Covers
bringing the stack up on one host, registering the first project and
repository, running the worker as a service, and the day-to-day operations
around it. Every command below is checked against the code as of this
writing; a route or flag that has moved is a bug in this document, not a
product decision.

The admin web view (`apps/web/src/views/AdminView.tsx`) is a placeholder
until GOT.29. Until then, projects and repositories are registered with the
`curl` examples in this document instead of a form.

## 1. First-time host setup

Everything the worker or the agents it spawns need on `PATH`:

| tool | why | check |
| --- | --- | --- |
| `git` 2.x | worktrees, commits (docs/design.md §9.1) | `git --version` |
| `gh`, authenticated with `repo` and PR scope | the agent opens PRs (D10) | `gh auth login --scopes repo`, then `gh auth status` |
| `node` 22+ | runs the worker and both agent runtimes' tooling | `node --version` |
| `corepack` | this repo's `pnpm` is reachable only via `corepack pnpm` | `corepack enable` |
| `claude` CLI, logged in, or `ANTHROPIC_API_KEY` set | the Claude adapter (docs/design.md §7.1) | run `claude` once and complete login, or set the key in `.env.worker` |
| `codex` CLI | only for repositories whose `default_runtime` is `codex` | `codex --version`; the worker refuses to claim a Codex task without it and just logs a warning (docs/design.md §7.3) |
| each repository's own toolchain (e.g. the runtime `setup_command`/`test_command` need) | the review role runs the real test command (docs/design.md §7.1) | whatever that repository requires |

`gh` honors the `GITHUB_TOKEN` environment variable for non-interactive
auth as an alternative to `gh auth login`; the worker exports the same
variable into every agent's environment (docs/design.md §15.3), so setting
`GITHUB_TOKEN` once in `.env.worker` covers both.

## 2. Compose bring-up

From the repository root:

```sh
cp .env.example .env
openssl rand -base64 48   # paste the output over the SESSION_SECRET placeholder in .env
docker compose up -d --build
docker compose ps
```

Expected `docker compose ps` output: `db` healthy, `migrate` `Exited (0)`
(it runs the migration once and stops), `api` and `web` running. `api` now
listens (`apps/api/src/index.ts`, `apps/api/src/app.ts`) rather than exiting
immediately.

`.env`'s `NODE_ENV` defaults to `production`, which marks the session
cookie `Secure` (`apps/api/src/routes/auth.ts`); set it to `development`
for logging in over plain `http://localhost` instead of TLS, and keep it
`production` behind TLS for anything reachable off this machine.

```sh
curl -s http://localhost:8080/api/health
```

Should return `{"status":"ok"}` — `apps/api/src/routes/health.ts`, proxied
through `apps/web/nginx.conf`.

Run the compose smoke test for a fuller check (env completeness, migrate
exit code, the `tasks` table, and the nginx SSE proxy config):

```sh
bash scripts/compose-smoke.sh
```

## 3. Creating the first user

`apps/api`'s `users:add` CLI (`apps/api/src/cli/users-add.ts`) is the only
way to create a user; there is no signup route (design D9). It reads
`DATABASE_URL` and `SESSION_SECRET` the same way the api server does, so
run it with the same `.env`:

```sh
set -a; source .env; set +a
corepack pnpm --filter @orchestra/api users:add jane@example.com --name "Jane Doe"
```

Prompts for a password on the tty (or reads one non-interactively from the
`PASSWORD` environment variable). Password must be at least 12 characters
(`apps/api/src/lib/users.ts`, `MIN_PASSWORD_LENGTH`).

Log in and keep the session cookie for the next steps:

```sh
curl -s -c /tmp/orchestra-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"jane@example.com","password":"<the password just set>"}' \
  http://localhost:8080/api/auth/login
```

`POST /api/auth/login` is defined in `apps/api/src/routes/auth.ts`. Every
other route requires this cookie (`apps/api/src/plugins/auth.ts`).

## 4. Registering a project

`POST /api/projects` (`apps/api/src/routes/projects.ts`). `key` must match
`^[A-Z][A-Z0-9_]+$` (the Jira project key); `jira_jql` is used verbatim with
`ORDER BY created ASC` appended by the poller
(`apps/worker/src/jira/poller.ts`) — include a label filter here to opt
tickets in per D6, e.g. `project = GOT AND labels = orchestra-managed`.

```sh
curl -s -b /tmp/orchestra-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{
        "key": "GOT",
        "name": "Goopter Ticket Orchestra",
        "jira_jql": "project = GOT AND labels = orchestra-managed"
      }' \
  http://localhost:8080/api/projects
```

`max_infra_retries` (default 3), `max_protocol_retries` (default 2),
`max_ci_rounds` (default 3), and `max_review_rounds` (default 3) are
optional and match the D13 defaults; pass them to override per project.
Note the returned `id` — it is the repository's `project_id` below.

## 5. Registering a repository

`POST /api/repositories` (`apps/api/src/routes/repositories.ts`).
`git_url` must be an `ssh` (`git@host:org/repo.git`) or `https` URL with an
org and repo segment. `default_runtime` is `"claude"` or `"codex"`
(`packages/core/src/enums.ts`). `test_command` and `setup_command` are
optional and nullable; `test_command` is rejected if it contains
`( ) * & ; | \` $ < >` or ends in `:*` (mirrors the review role's allow-list
policy, `apps/api/src/routes/repositories.ts`).

```sh
curl -s -b /tmp/orchestra-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{
        "project_id": "<project id from step 4>",
        "name": "orchestra-sandbox",
        "git_url": "git@github.com:your-org/orchestra-sandbox.git",
        "default_branch": "main",
        "default_runtime": "claude",
        "max_concurrent_worktrees": 2,
        "required_capability": null,
        "setup_command": "pnpm install",
        "test_command": "pnpm test"
      }' \
  http://localhost:8080/api/repositories
```

`required_capability`, if set, must match one of the worker's
`WORKER_CAPABILITIES` tags (docs/design.md §4.2, `agent_workers.capabilities`)
or no worker will ever have capacity for the repository's tasks.

## 6. Building and starting the worker

```sh
corepack pnpm --filter @orchestra/worker build
cp deploy/worker.env.example .env.worker   # then fill in every value
```

### Every variable the worker reads

From `apps/worker/src/config.ts` (the source of truth; `.env.example` and
`deploy/worker.env.example` list the same variables and defaults):

| variable | default | notes |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | host-published Postgres port |
| `WORKER_HOST` | `os.hostname()` | unique key of the `agent_workers` row |
| `WORKER_CAPABILITIES` | `[]` (empty) | comma list, matched against `repositories.required_capability` |
| `WORKER_MAX_CONCURRENT` | `2` | integer 1-1024 |
| `WORKER_WORKSPACE_ROOT` | `~/orchestra` | leading `~` is expanded |
| `WORKER_TOOLS_PORT` | `4317` | agent-tools MCP server, loopback only |
| `WORKER_DISK_HIGH_WATER_PCT` | `85` | integer 1-100, worktree sweeper rule 4 |
| `AGENT_QUIET_TIMEOUT_MS` | `1200000` (20 min) | integer 1000 - 86400000 |
| `PRICING_FILE` | `config/pricing.json` | a relative path is resolved against the repository root, not `WorkingDirectory`; a missing or invalid file stops the worker at startup |
| `PUBLIC_URL` | none (optional) | used in Jira comment links |
| `JIRA_BASE_URL` | none (optional) | with `JIRA_EMAIL`/`JIRA_API_TOKEN`, enables the Jira poller and write-back loop |
| `JIRA_EMAIL` | none (optional) | see above |
| `JIRA_API_TOKEN` | none (optional) | see above |
| `GITHUB_TOKEN` | none (optional) | exported into every agent's environment |
| `ANTHROPIC_API_KEY` | none (optional) | omit to rely on the host's `claude` CLI login |
| `OPENAI_API_KEY` | none (optional) | required for Codex-runtime repositories |
| `LOG_LEVEL` | `info` | one of `fatal, error, warn, info, debug, trace, silent` |

Then either:

```sh
deploy/launchd/install.sh     # macOS
deploy/systemd/install.sh     # Linux
```

See `deploy/README.md` for what each installer does. Both build a `PATH`
from `which git gh node claude codex` and bake it into the service; rerun
the installer after installing a new tool so the service picks it up.

### What a clean start logs

In order (`apps/worker/src/index.ts`):

1. `"worker registered"` — the `agent_workers` row was upserted
   (`apps/worker/src/registration.ts`); the log line includes the redacted
   config (secrets stripped, `apps/worker/src/config.ts`'s `redactConfig`).
2. The agent-tools MCP server binds to `127.0.0.1:$WORKER_TOOLS_PORT`
   (docs/design.md §8); a bind failure exits the process with an error log
   instead.
3. `"detected agent runtimes"` — which of `claude`/`codex` were found on
   `PATH` (`apps/worker/src/scheduler/runtimes.ts`).
4. If Jira credentials are incomplete: a warning,
   `"JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN is missing; Jira poller not started"`
   (and the same for the write-back loop) — the worker still starts
   (`apps/worker/src/jira/poller.ts`, `writeback.ts`).
5. `"worker started"` — includes the 5 second scheduler tick interval, the
   30 second heartbeat interval, and the phase order.

### Verifying registration and heartbeat

```sh
psql "$DATABASE_URL" -c \
  "select host, capabilities, max_concurrent, last_heartbeat_at, started_at from agent_workers;"
```

or, once logged in as a user, the same data plus derived free capacity via
the api (`GET /api/workers`, `apps/api/src/routes/workers.ts` — this route
already works even though the admin page that will render it is still the
GOT.29 placeholder):

```sh
curl -s -b /tmp/orchestra-cookies.txt http://localhost:8080/api/workers
```

`last_heartbeat_at` should advance roughly every 30 seconds
(`apps/worker/src/heartbeat.ts`).

## 7. Rotating tokens

Jira, GitHub, and Anthropic/OpenAI credentials all live in `.env.worker`
(never in Postgres, docs/design.md §15.3). To rotate one: edit the value in
`.env.worker`, then restart the unit —

```sh
launchctl kickstart -k gui/$(id -u)/com.goopter.orchestra-worker   # macOS
systemctl --user restart orchestra-worker.service                 # Linux
```

Agent-tools tokens (the per-execution MCP bearer token, docs/design.md §8)
are minted at execution start/resume and revoked when the execution leaves
`RUNNING`; there is nothing to rotate manually.

The api's `SESSION_SECRET` lives in the compose `.env`, not `.env.worker`;
rotating it invalidates every signed session cookie and is a
`docker compose up -d api` away, not covered further here since it is not a
worker concern.

## 8. Where worktrees live, and the sweeper

```
<WORKER_WORKSPACE_ROOT>/repos/<repository.name>.git    bare mirror, one per repository per host
<WORKER_WORKSPACE_ROOT>/work/<execution.id>/           one worktree per execution
```

(docs/design.md §9.1, `apps/worker/src/worktrees/manager.ts`).
`WORKER_WORKSPACE_ROOT` defaults to `~/orchestra`.

The worktree sweeper (`apps/worker/src/sweeper/worktrees.ts`) runs hourly
and, in order:

1. Removes the worktree and local branch for any task that is `DONE` or
   `CANCELLED`, once 24 hours have passed since the execution ended
   (`FINISHED_RETENTION_MS`, the `"finished"` class).
2. Removes the worktree and local branch for any execution that `FAILED`
   with no retry pending, once 24 hours have passed since it ended
   (`FINISHED_RETENTION_MS`, the `"failed"` class).
3. For an execution `WAITING_FOR_USER` or a task `NEEDS_HUMAN`, idle more
   than 14 days (`IDLE_EVICTION_MS`, the `"idle"` class): pushes the branch
   if it is ahead of `origin`, removes the worktree, and stamps
   `executions.worktree_evicted_at`.
4. If disk usage of `WORKER_WORKSPACE_ROOT` exceeds
   `WORKER_DISK_HIGH_WATER_PCT` (default 85), evicts the oldest eligible
   worktree from the idle class (rule 3) first, then the failed class
   (rule 2), until back under the threshold. `DONE`/`CANCELLED` worktrees
   (rule 1) are never touched by disk pressure, only by the 24-hour rule
   above (`apps/worker/src/sweeper/worktrees.ts`, the `pressure` array).

Resuming an execution whose worktree was evicted recreates it from the
pushed remote branch before starting the session; the session id itself is
stored separately and is still valid.

### Evicting a worktree manually

Only do this when the execution is not `RUNNING`/`ASSIGNED` — stop the unit
first if unsure:

```sh
launchctl bootout gui/$(id -u)/com.goopter.orchestra-worker   # macOS
systemctl --user stop orchestra-worker.service                # Linux
```

Then, from `WORKER_WORKSPACE_ROOT`, push any unpushed commits and remove the
worktree:

```sh
git -C repos/<repository-name>.git push origin <branch>          # if the branch has local-only commits
git -C repos/<repository-name>.git worktree remove --force work/<execution-id>
```

Finally mark it evicted so a later resume recreates the worktree from the
remote branch instead of expecting the local one:

```sh
psql "$DATABASE_URL" -c \
  "update executions set worktree_evicted_at = now() where id = '<execution-id>';"
```

## 9. Troubleshooting

**Worker never claims a task on a repository whose `default_runtime` is
`codex`.** The claim phase only assigns a task whose runtime binary the
worker detected on `PATH` at startup; without it, it logs
`"task runtime binary not on PATH, not claiming"` and waits for a
Codex-capable worker instead of failing the task (docs/design.md §7.3,
`apps/worker/src/scheduler/claim.ts`). Install `codex`, confirm
`codex --version`, and restart the unit.

**An execution is stuck `ASSIGNED`/`RUNNING` after a worker crash.** Task
leases expire after 5 minutes (`LEASE_TTL_MS`,
`apps/worker/src/agent-tools/lease.ts`, D13); the sweeper then transitions
the execution to `FAILED` with `end_reason = lease_expired` and applies the
retry policy — a fresh execution with `host = NULL` that any worker can
claim. No manual action needed once 5 minutes have passed; the local
worktree is left for the eventual retry or the 24-hour cleanup rule above.

**A command aimed at an execution pinned to a host that is gone.** Commands
targeting an execution pinned to another host wait for that host, unless it
has not heartbeated in 15 minutes (`DEAD_HOST_AFTER_MS`,
`apps/worker/src/sweeper/index.ts`), at which point the pin is cleared and
any worker may pick up the command with a fresh session.
