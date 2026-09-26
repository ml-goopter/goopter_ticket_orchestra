# Build order

Execution order for the tracker tasks (GOT.10 to GOT.49). It refines docs/design.md §16 into waves: tasks in one wave have their dependencies met and own disjoint paths, so up to two run in parallel. Each task's plan and spec is approved by the user before dispatch (CLAUDE.md, workflow step 2).

Status as of 2026-09-25, main at `ff8273a` plus this change.

## Completed

| Wave | Task | Title | PR |
| --- | --- | --- | --- |
| W0 | GOT.10 | Scaffold pnpm monorepo and tooling | direct to main |
| W1 | GOT.11 | core: domain enums, types, SpecContent schema | #1 |
| W2 | GOT.12 | core: task and execution state machines | #2 |
| W2 | GOT.13 | db: Drizzle schema and migrations | #3 |
| W2 | GOT.14 | adapters: AgentAdapter interface and Claude implementation | #6 |
| W2 | GOT.15 | prompts: system prompts and prompt assembly | #5 |
| W3 | GOT.16 | db: transition() with audit events and NOTIFY | #4 |
| W3 | GOT.17 | compose: db, migrate, api, web, env template | #7 |
| W4 | GOT.18 | api: Fastify skeleton, sessions, auth, users:add CLI | #8 |
| W4 | GOT.19 | worker: skeleton, registration, heartbeat, tick loop | #9 |
| W5 | GOT.20 | api: admin routes | #14 |
| W5 | GOT.21 | api: task routes, cancel, retry, dependency and runtime patch | #12 |
| W5 | GOT.22 | web: app shell, login, routing, api client, SSE client | #10 |
| W5 | GOT.24 | worker: agent-tools MCP server with bearer tokens | #15 |
| W5 | GOT.25 | worker: worktree manager | #22 |
| W5 | GOT.23 | worker: Jira client and poller | #23 |
| W5 | GOT.26 | worker: scheduler phases, claim, leases, capacity | #24 |
| W5 | GOT.28 | api: LISTEN connection and SSE endpoints | #26 |
| W5 | GOT.32 | api: specification routes | #27 |
| W5 | GOT.33 | api: issue routes, resolution, notifications | #28 |
| W5 | GOT.40 | review-wrapper: orchestra-review binary | #29 |
| W6 | GOT.36 | web: board view and attention drawer | #30 |
| W6 | GOT.31 | worker: execution runner loop and command consumer | #31 |
| W6 | GOT.34 | worker: lease sweeper and dead-host release | #32 |
| W6 | GOT.41 | web: task detail timeline and side panel | #33 |
| W6 | GOT.35 | worker: worktree sweeper | #34 |
| W6 | GOT.30 | worker: Jira comment write-back | #35 |
| W7 | GOT.42 | web: issue detail view | #36 |
| W7 | GOT.39 | worker: implementation role with review phase | #37 |
| W7 | GOT.44 | cost: pricing table, /costs route, costs view | #38 |
| fill-in | GOT.27 | deploy: worker service units and operator runbook | #39 |
| W7 | GOT.43 | worker: failure classification and retry policy | #40 |
| fill-in | GOT.29 | web: admin views for projects, repositories, users, workers | #41 |
| W7 | GOT.38 | web: spec builder split pane | #42 |
| W9 | GOT.45 | adapters: Codex implementation | #43 |
| W8 | GOT.46 | worker: GitHub poller | #44 |
| W7 | GOT.37 | worker: spec role execution | #45 |
| W8 | GOT.47 | worker: issue conversation and resume commands | #46 |

Fixes and process changes: #11 drizzle boundary, #13 hotfix, #16 severity rule, #17 agent-tools lock order and lease, #18 review test command and SSE, #19 per-task approval, #20 login timing, free slots, user patch, #25 per-task event commit order (appendEvent advisory lock).

## Remaining

Order within a wave is priority order. Critical path: GOT.48 → GOT.49; GOT.50 is a fill-in that can run before either.

| Wave | Task | Title | Depends on | Milestone |
| --- | --- | --- | --- | --- |
| fill-in | GOT.50 | worker: project budget cap and Codex usage pricing | GOT.44, 45, 47 | M9 |
| W9 | GOT.48 | E2E: sandbox ticket to merged PR through Claude | GOT.38 to 42, 46, 47 | M6 |
| W9 | GOT.49 | E2E: same ticket through Codex | GOT.45, 48 | M9 |

Both fill-in tasks (GOT.27, GOT.29) are done. GOT.29 ships without a user disable control (C40): the tracker asks for one, but commit 0167d86 removed the field from `PATCH /users/:id` because design §13 names no such route. Restoring it needs a user decision and is a small api change plus a toggle.

GOT.27's units have not been loaded under launchd on this machine; that is an operator step recorded in `docs/runbook.md` and outside the review loop (PR #39). Plain-http localhost use needs `NODE_ENV=development` for the session cookie (C37).

GOT.38 took five review rounds (cap 3, extended twice): rounds 1-3 each found one new major and round 4 a pre-existing recovery gap; round 5 was clean (PR #42).

GOT.45 was built early against synthesized `codex exec --json` fixtures because `codex` is not installed on this host (design OI1). The adapter is registered in the worker but is unverified against a real Codex run; see the GOT.49 notes (PR #43).

## Carry-forward notes

- All worker tasks: lease renewal must go through the state-gated db helper; a bypass can renew a cancelled execution. Every transaction that locks both rows takes the task row before the execution row (PR #17, #31).
- GOT.48: the worktree manager's setup command inherits the full worker environment (database URL, tokens, API keys) and has no timeout. Deferred past GOT.31 and GOT.39 without a user decision to change it; the end-to-end run should decide whether to scrub the environment and bound the command (PR #22, #31, #37).
- Later: call `applyCiFailure` from `packages/db/src/queries/ci.ts` inside a transaction that locks task then execution; it returns `{ applied: false, reason }` for a stale pull request id or head sha and the poller must treat that as "already superseded", not an error. `resume_with_ci_failure` carries `{ pull_request_id, head_sha, round, checks: [{ name, url, log_excerpt }] }` (PR #37).
- Later: `report_pr_created` now updates the task's single `pull_requests` row and resets it to open; the poller should key its state on `head_sha`, not on row identity (C17, C22, PR #37).
- Later: command handlers return `handled`, `unclaimed` or `skipped` (C20). Only an execution pinned to another host unclaims. A CI resume for an unpinned execution (host null after a dead-host release) is skipped and completed, leaving the task IMPLEMENTING with a COMPLETED execution. The retry starter (GOT.43) handles only QUEUED retry rows, so the fresh-session fallback for released WAITING_FOR_USER and COMPLETED executions (D5, §6.1) is GOT.47's: on OTHER_HOST with `host` null, pin the execution to this host and start a fresh session seeded with the spec, decisions and the pending prompt (C21, PR #37, #40).
- Later: the retry policy (PR #40) runs inside the FAILED transaction in the runner and the lease sweeper; a spec-role infrastructure failure only notifies (no task edge from SPEC_IN_PROGRESS) and the starter runs implementation rows only, so a failed spec session needs the user to start a new one. Retry rows copy `session_id`; the starter reuses a local worktree (resume when `canResume`, else a fresh session there, C31, C32) and every worktree operation after creation is keyed on the row's recorded `worktree_path` (C33). The failed row keeps `branch` and loses `worktree_path` after a takeover (C38).
- GOT.50: `projects.max_budget_usd` exists (migration 0004, C29) but nothing reads it: the runner does not pass `maxBudgetUsd` to the adapter and no path produces `budget_exceeded`; `codex exec` has no budget flag, so the check belongs in the runner (PR #38, #43, C30).
- GOT.50: Codex usage events carry no `costUsd` (C47) and the runner has no pricing hook: `runner.ts` records `costUsd ?? 0`, so Codex cost lands as 0 rather than NULL, and `modelFor` returns undefined for the default model so the usage row says `unknown`. Wire `apps/worker/src/pricing` into the runner's usage path and record the Codex model name (PR #43).
- GOT.49: the Codex adapter's assumptions need one real run to verify: `-c` keys `mcp_servers.orchestra.url`, `mcp_servers.orchestra.bearer_token_env_var` and `sandbox_workspace_write.network_access` (all in `CODEX_CONFIG_KEYS`); whether Codex's default `shell_environment_policy` strips `*TOKEN*` variables, which would hide `ORCHESTRA_TOKEN` and `GITHUB_TOKEN` from `orchestra-review` and `gh`; whether `turn.completed` usage is cumulative across `exec resume` (the baseline subtraction assumes it is) and whether `input_tokens` includes `cached_input_tokens`; the flag order `exec <flags> resume <id> -` with `-` for stdin; item type names (`agent_message`, `command_execution`, `mcp_tool_call`, `file_change`, `web_search`); the session store at `$CODEX_HOME/sessions`; and whether older versions need `experimental_use_rmcp_client=true` for HTTP MCP (PR #43).
- Later: the runner maps a Codex adapter `error` event to `adapter_error`, so a Codex process crash is not recorded as `process_crash`; and no test covers the adapter's kill-once guard (PR #43, accepted minor).
- GOT.48: the UI labels every Claude cost "estimated" (C28, design OI2) because the api cannot tell an API-key login from a subscription login. Revisit if the host reports it.
- Later: a `WorktreeManager.prepareImplementation` call must follow the end of any earlier session for the same task, because a stale worktree holding the task branch is detached (PR #22).
- All tasks: run `pnpm typecheck` (or build) before `pnpm test` in a fresh checkout. Worker tests load workspace packages from `dist`, and a stale `dist` fails tests unrelated to the change.
- Later: the claim inserts the execution QUEUED and moves it to ASSIGNED but never writes the §9.6 `execution.queued` event; retry rows do write it (PR #40).
- Later: command handlers register with `registerCommandHandler(type, handler)` in `apps/worker/src/runner/commands.ts`; a type with no handler is left unclaimed. The runner's `resume({ executionId, prompt, usageKind })` is the entry point for `resume_with_*` and `send_message`; it refuses when `canResume` is false (PR #31).
- Later: core has ASSIGNED → FAILED on `execution.failed` (O1) and the §5.2 diagram does not show it (PR #31). `apps/worker/test/runner.test.ts` "resets the quiet timer on every event" is a timing flake under load (300 ms timeout against 100 ms gaps with db writes inside the window); it failed once during PR #40 integration and was traced to main. Widen the margin or inject timers in a follow-up (PR #40).
- Later: the retry policy writes a `needs_human` notification when an infrastructure failure hits a READY task (a human retried while the old execution was still RUNNING) although the task has no escalation edge and does not move; `POST /tasks/:id/retry` should refuse while an execution is live, which closes both (PR #24, #40, accepted minor).
- Later: spec sessions hold no lease, so the runner renews only for the implementation role. A resumed session's new session id is not stored on resume (PR #31).
- GOT.48: the runner flushes buffered deltas before every later event, but a runtime that runs tools without consumer backpressure can still write a tool's own event first, so timeline order is best-effort there (PR #31, accepted minor).
- Later: a dead-host release leaves a WAITING_FOR_USER or COMPLETED execution with `host` and `worker_id` null and `runner.resume` refuses it (OTHER_HOST); see the C21 note above for the fallback this task owns (PR #32, #40).
- Later: `runner.resume` re-reads the host pin under the lock and refuses when it changed; a command handler must treat OTHER_HOST as "not mine" and leave the command for another worker rather than fail the execution (PR #32).
- All worker tasks: lock order is the repository lock, then the task row, then the execution row. Never call the worktree manager from inside a row-locking transaction; a fetch or push can hold the repository lock up to `networkTimeoutMs` (PR #34).
- Later: `runner.resume` handles `worktree_evicted_at` by recreating the worktree at the row's recorded path from `origin/<branch>`, or from the default branch with a warning and `start_point: "default_branch"` in `worktree.prepared` when the remote branch is absent; spec executions use `prepareSpec`. A git failure during recreation is refused with WORKTREE_UNAVAILABLE and leaves no directory behind (PR #34, #40).
- Later: executions released from a dead host (`host` null) match no host in the worktree sweeper, so their worktrees are never swept anywhere. Reclaiming or sweeping them needs an owner (PR #32, #34).
- Later: `repositories.name` is unique per project but the bare clone path `repos/<name>.git` is shared across projects, so two projects with one repository name share a bare clone and branch namespace (PR #34, pre-existing).
- Later: web api client methods are layered as `ApiClient` -> `BoardApiClient` -> `IssueApiClient` in `apps/web/src/api/client.ts`; add a further layer rather than widening an existing interface, and extend `makeFakeClient` in `apps/web/src/task/fixtures.ts`. Action handlers may set state without the fetch guard, matching `TaskDetailView` (PR #33, #36, accepted minor).
- Later: the issue view posts messages only while the issue is OPEN and shows the api's EXECUTION_NOT_WAITING as "the agent is busy"; the worker must return the execution to WAITING_FOR_USER after each reply (§9.3) or the composer stays disabled (PR #36).
- Later: the Jira write-back cursor lives in memory and starts at the current max event id on worker start, and a transient failure is retried five times per event (C14). A restart or a Jira outage longer than about five runs drops that window's comments with no backfill; a persisted cursor or a reconciliation sweep would close it (PR #35, accepted minor).
- Later: the write-back posts "Pull request opened" on `pull_request.created` and "CI passed. Ready for merge" on `task.state_changed` to READY_FOR_MERGE; the poller needs no Jira code of its own (PR #35).
- User decision needed: the GOT.29 tracker item asks for a user disable control, but commit 0167d86 deliberately removed `disabled` from `PATCH /users/:id` because design §13 names no route for it. GOT.29 ships without the control (C40) and shows `disabled_at` read-only. Restoring it is a small api change plus a toggle.
- GOT.34/35: `BLOCKED → READY` (`dependency.resolved`) is not implemented; the user left it out of GOT.26 because §6.2 does not specify it.
- Later: request-review marks the spec execution COMPLETED in the database only; the worker's C44 poll aborts the live session and the row-locked write gate (F5, PR #45) refuses any later runner write to it. Send-back enqueues `send_message` and the worker resumes through the COMPLETED → RUNNING `execution.resumed` edge (C45, PR #27, #45).
- Later: request-review refuses while a `start_spec_session` command is uncompleted; the worker completes that command and creates the spec execution in one transaction (PR #27, #45).
- Later: the scheduler's live and paused execution filters ignore `role`, so any live spec execution also blocks promotion and claim of the task (PR #24, #27).
- Later: `PUT /spec/draft` takes `{ content }`. `/spec/revise` returns 409 `DRAFT_EXISTS` when a draft already exists, and no route deletes a draft (PR #27).
- GOT.42: `GET /stream` has no publisher for `notification` events; notifications are rows in their own table and never reach `NOTIFY` (user decision Q7, PR #26). The issue views must poll or refetch.
- Later: `send_message` on an issue carries `{ issue_id, text }` and `resume_with_decision` carries `{ issue_id, decision_id }`. Both are enqueued only while the execution is WAITING_FOR_USER; a message on a non-blocking issue is refused with 409 (PR #28).
- Later: resolving as `spec_revision` leaves the execution WAITING_FOR_USER and enqueues nothing; `/spec/approve` later enqueues `resume_with_revision` (PR #27, #28).
- GOT.42: broadcast notifications (`user_id` null) share one `read_at` across users; one user's read marks it read for all (PR #28, accepted as designed).
- Later: `GET /stream` has no replay (user decision Q8); every view must refetch when the stream reconnects. Reuse `apps/web/src/board/useEventReconnect.ts` and the `useLatestRequest` stale-response guard from PR #30 (PR #26, #30).
- Later: never put `?after=` in the URL given to `useEventStream`; the hook appends its own `after=` on reconnect and the api rejects a doubled param with 400. Subscribe with the bare URL before loading pages and merge by event id, as `TaskDetailView` does (PR #33). Pass `types` explicitly (PR #18).
- Later: a routed view that keeps state must key its stateful panel on the route param, or in-app navigation between two ids keeps the old state; see `TaskDetailView` (PR #33).
- Later: the web api client's typed methods live in `apps/web/src/api/types.ts` and `client.ts` (`BoardApiClient`); extend them there and update the typed fake in `apps/web/src/task/fixtures.ts`. `AppLayout` owns the client instance. Run `cd apps/web && npx tsc --noEmit -p tsconfig.json` as well as the root typecheck: the root build excludes web test files (PR #30, #33).
- Later: `@orchestra/prompts` is a web dependency for `renderSpecMarkdown` and `diffSpecs` (user decision Q13, PR #33).
- GOT.39: `StartRequest.testCommand` carries the repository test command to the review role and must be a single plain command. The wrapper reads it from `context.review_command`; where that value comes from is design OI3 and needs a decision.
- GOT.39: the runner must prepend `packages/review-wrapper/bin` to the agent's PATH (user decision Q7, no bundler) and invoke `orchestra-review --round N` after `report_review_started(N)`. Read the exit code, not stdout, for the outcome: 0 clean, 1 findings, 2 ask_user, 3 error. The round-limit stop instruction from `report_review_result` reaches the agent only on the wrapper's stderr (PR #29).
- GOT.39: the wrapper calls `report_review_result` itself, so the implementing agent must not call it again for the same round (PR #29).
- GOT.31: `.orchestra/context.json` now requires `runtime`; the worktree manager writes it from its input (PR #29).
- GOT.44: `report_usage` records one `execution_usage` row per review round with `kind = review`; a multi-model session reports its models comma-joined in `model` (PR #29).
- GOT.48: the wrapper has not been run against real Claude. Tests use a fake adapter and an in-process MCP server. The first live run needs a running worker, an execution token and Claude credentials on the host (PR #29).
- GOT.48: the GitHub poller (PR #44) anchors the no-checks grace on a `pending_since` it writes into `ci_detail` on the first poll with zero check runs, never on `created_at` (C50). A task merged on GitHub while CI_RUNNING passes through READY_FOR_MERGE with `via: "merged_externally"` in the event payload and the Jira write-back skips that event (C51); `transition()` takes an optional `eventPayload` merged into the state_changed payload. Log excerpts use the check run `id` as the Actions job id. The first live run should confirm the excerpt fetch and the C50 timing against a real repository.
- Later: the spec role (PR #45) runs `start_spec_session` and spec `send_message` through handlers in `apps/worker/src/runner/spec.ts`; a `send_message` on a WAITING_FOR_USER spec execution is skipped there and needs its own branch for the issue conversation. Spec-role handlers map `NO_SESSION` and `CANNOT_RESUME` to `skipped` with an error log; do the same for issue resumes. The runner's `RunnerDeps.hooks.beforeTokenIssue` is a test seam only.
- GOT.48: a spec execution stays RUNNING between turns and holds a slot while the user drafts (C42); the C48 dead-host pass fails an ASSIGNED spec execution after 15 minutes without a heartbeat; `POST /tasks/:id/spec/session` restarts from SPEC_IN_PROGRESS when no spec execution is live and no send-back resume is pending, else 409 `SPEC_SESSION_BUSY` (C49). The worktree sweeper removes a spec worktree once the task is past SPEC_REVIEW (C46); if approval picks a different repository than the C41 fallback, the prune runs in the wrong bare clone but the directory is still removed (PR #45).
- Later: implementation executions cancelled by the api keep receiving agent events until the runner's poll notices the stop; the spec-only write gate (PR #45) does not cover them because §9.3 lets an implementation write its final message after a tool-driven COMPLETED. `recordUsage` still writes usage after request-review so spend is not lost (PR #45, accepted).
- GOT.48: issue conversation and resumes (PR #46) live in `apps/worker/src/runner/issues.ts`. A message on an open blocking issue returns the execution to WAITING_FOR_USER; the resume transaction locks task, execution, then issue and skips with `ISSUE_NOT_OPEN` when the api resolved it first. `resume_with_revision` rewrites `.orchestra/context.json` before the adapter call (C53) so `orchestra-review` sees the new revision. Decisions and messages also reach a spec execution parked on a blocking issue (C54). An execution released from a dead host (`host` null) or whose session cannot resume gets a fresh session on this worker with the full prompt and `fresh_session: true` in `execution.resumed` (C21); spec executions have no fallback and are skipped at error level. `task_leases.worker_id` still names the dead worker after a takeover; renewal is keyed by execution id (accepted minor). `RunnerDeps.hooks.beforeFallbackPin` and `beforeTokenIssue` are test seams.
- GOT.48 and GOT.49: need a sandbox GitHub repository, a Jira project, and credentials from the user.
