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

## Starting and stopping

After the first run, day-to-day start-up is two steps.

1. Start Postgres, the api and the web UI:

   ```sh
   docker compose up -d
   ```

2. Start the worker, which runs the agents. If it is installed as a service
   (`deploy/`), it is already running. Otherwise run it in the foreground
   from the repository root, with `.env.worker` created from
   `deploy/worker.env.example` (`docs/runbook.md` §6):

   ```sh
   corepack pnpm --filter @orchestra/worker build
   set -a; source .env.worker; set +a
   node apps/worker/dist/index.js
   ```

   A clean start logs `worker registered`, `detected agent runtimes` and
   `worker started`. A warning that Jira credentials are missing means no
   tickets will be imported.

To stop, press Ctrl-C in the worker terminal (or stop the service), then
run `docker compose down`. Do not pass `-v` for a routine stop: it deletes
the database volume.

After pulling changes to `apps/web`, rebuild the UI with
`docker compose build web && docker compose up -d web`.

## Using it

Open <http://localhost:8080> and log in with a user created by `users:add`.
The project and repository must already be registered (`docs/runbook.md`
§4-5), and the worker's `GITHUB_TOKEN` must be able to push to the
repository and open pull requests.

1. **File a ticket.** Create a Jira ticket that matches the project's JQL,
   for example by adding the label the JQL filters on
   (`orchestra-managed` in the runbook example). The worker polls Jira every
   minute; the ticket appears on the board in **Needs Spec**.
2. **Write the spec.** Open the task, click **Open spec builder**, then
   **Start spec session**. The spec agent reads the repository and proposes
   a specification in the right pane. Chat with it in the left pane, or edit
   the form directly and click **Save Draft**.
3. **Approve.** Click **Request Review**, then **Approve**. The runtime
   defaults to the repository's; change it only to override this task. The
   task moves to **Ready** and the worker claims it within seconds.
4. **Watch it work.** The agent implements the change, runs the test
   command, has a fresh-context reviewer check the diff, pushes a branch and
   opens a pull request. The task page timeline shows each step; the side
   panel shows the spec, executions, cost, and pull request.
5. **Answer questions.** When an agent needs a decision it raises an issue
   and pauses. The **Attention** button in the top bar shows the count.
   Open the issue, reply in the thread if you need to, then resolve it:
   - **Resolve as clarification**: the agent resumes with your answer.
   - **This changes the spec**: the task returns to the spec builder with a
     new draft; edit it and approve again, and the agent resumes against the
     new version.
6. **Merge.** When CI passes, the task moves to **Ready for Merge**. Review
   and merge the pull request on GitHub; the task moves to **Done** within a
   minute.

If a task lands in **Needs Human** (retries exhausted, CI round limit, or
the agent gave up), the reason is on the task page. Use **Retry** to start a
fresh execution or **Cancel** to stop.

Jira receives a comment at each milestone (spec approved, pull request
opened, CI passed, needs human). The ticket's Jira status is never changed.

Costs per project, task and runtime are under **Costs**. Projects,
repositories, users and worker health are under **Admin**.
