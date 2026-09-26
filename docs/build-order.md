# Build order

Execution order for the tracker tasks (GOT.10 to GOT.49). It refines docs/design.md §16 into waves: tasks in one wave have their dependencies met and own disjoint paths, so up to two run in parallel. Each task's plan and spec is approved by the user before dispatch (CLAUDE.md, workflow step 2).

Status as of 2026-09-25, main at `ea22af9` plus this change.

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

Fixes and process changes: #11 drizzle boundary, #13 hotfix, #16 severity rule, #17 agent-tools lock order and lease, #18 review test command and SSE, #19 per-task approval, #20 login timing, free slots, user patch, #25 per-task event commit order (appendEvent advisory lock).

## Remaining

Order within a wave is priority order. Critical path: GOT.31 → GOT.39 → GOT.46 and GOT.47 → GOT.48 → GOT.49.

| Wave | Task | Title | Depends on | Milestone |
| --- | --- | --- | --- | --- |
| W6 | GOT.35 | worker: worktree sweeper | GOT.25 | M8 |
| W6 | GOT.30 | worker: Jira comment write-back | GOT.23 | M4 |
| W7 | GOT.37 | worker: spec role execution | GOT.31 | M5 |
| W7 | GOT.39 | worker: implementation role with review phase | GOT.26, 31 | M6 |
| W7 | GOT.38 | web: spec builder split pane | GOT.22, 28, 32 | M5 |
| W7 | GOT.42 | web: issue detail view | GOT.22, 28, 33 | M7 |
| W7 | GOT.43 | worker: failure classification and retry policy | GOT.26, 31 | M8 |
| W7 | GOT.44 | cost: pricing table, /costs route, costs view | GOT.22, 31 | M8 |
| W8 | GOT.46 | worker: GitHub poller | GOT.39 | M6 |
| W8 | GOT.47 | worker: issue conversation and resume commands | GOT.33, 39 | M7 |
| W9 | GOT.48 | E2E: sandbox ticket to merged PR through Claude | GOT.38 to 42, 46, 47 | M6 |
| W9 | GOT.45 | adapters: Codex implementation | GOT.14 | M9 |
| W9 | GOT.49 | E2E: same ticket through Codex | GOT.45, 48 | M9 |

Fill-in tasks with dependencies already met, run when a slot would otherwise sit idle: GOT.27 deploy units and runbook (GOT.17, 19), GOT.29 web admin views (GOT.20, 22).

GOT.45 is ready now but stays in W9 per design §16 step 9, because it needs `codex` installed on the worker host (design OI1).

## Carry-forward notes

- All worker tasks: lease renewal must go through the state-gated db helper; a bypass can renew a cancelled execution. Every transaction that locks both rows takes the task row before the execution row (PR #17, #31).
- GOT.39: the worktree manager's setup command inherits the full worker environment (database URL, tokens, API keys) and has no timeout. Deferred past GOT.31 by user decision; the implementation role is the next owner (PR #22, #31).
- GOT.43/47: a `WorktreeManager.prepareImplementation` call must follow the end of any earlier session for the same task, because a stale worktree holding the task branch is detached (PR #22).
- All tasks: run `pnpm typecheck` (or build) before `pnpm test` in a fresh checkout. Worker tests load workspace packages from `dist`, and a stale `dist` fails tests unrelated to the change.
- GOT.43: the claim inserts the execution QUEUED and moves it to ASSIGNED but never writes the §9.6 `execution.queued` event.
- GOT.37/46/47: command handlers register with `registerCommandHandler(type, handler)` in `apps/worker/src/runner/commands.ts`; a type with no handler is left unclaimed. The runner's `resume({ executionId, prompt, usageKind })` is the entry point for `resume_with_*` and `send_message`; it refuses when `canResume` is false, and the fresh-session fallback (D5) belongs to GOT.43 (PR #31).
- GOT.43: a failed execution (`setup_failed`, `adapter_error`, `agent_hung`, `protocol_violation`, `process_crash`) leaves the task IMPLEMENTING with `end_reason` set; the retry policy moves the task (user decision Q10). No `max_budget_usd` column exists anywhere; add it with the policy (Q9). Core now has ASSIGNED → FAILED on `execution.failed` (O1); the §5.2 diagram does not show it (PR #31).
- GOT.37: spec sessions hold no lease, so the runner renews only for the implementation role. A resumed session's new session id is not stored on resume (PR #31).
- GOT.39: the runner flushes buffered deltas before every later event, but a runtime that runs tools without consumer backpressure can still write a tool's own event first, so timeline order is best-effort there (PR #31, accepted minor).
- GOT.43: a lease expiry ends the execution FAILED `lease_expired` with the task left IMPLEMENTING (Q10); the retry policy must also handle a dead-host release, where a WAITING_FOR_USER or COMPLETED execution has `host` and `worker_id` null and `runner.resume` refuses it (OTHER_HOST). The fresh-session fallback (D5, §6.1) starts from that state (PR #32).
- GOT.47: `runner.resume` re-reads the host pin under the lock and refuses when it changed; a command handler must treat OTHER_HOST as "not mine" and leave the command for another worker rather than fail the execution (PR #32).
- GOT.35: the lease sweeper owns the `lease_sweeper` phase slot and `apps/worker/src/sweeper/index.ts`; put the worktree sweeper beside it and replace only the `worktree_sweeper` stub and its stub test entry in `apps/worker/src/phases/index.test.ts` (PR #32).
- GOT.43: `POST /tasks/:id/retry` moves NEEDS_HUMAN to READY even while the execution is still RUNNING (after a review-limit escalation). The claim skips READY tasks with a live execution, so the task waits, but the retry route should refuse or the escalation should end the execution (PR #24).
- GOT.34/35: `BLOCKED → READY` (`dependency.resolved`) is not implemented; the user left it out of GOT.26 because §6.2 does not specify it.
- GOT.37: request-review marks the spec execution COMPLETED in the database only; the worker must end the live spec session when it sees that. Send-back does not resume the session; the worker must (PR #27).
- GOT.37: request-review refuses while a `start_spec_session` command is uncompleted. The worker must complete that command and create the spec execution in one transaction, or the guard has a gap (PR #27).
- GOT.37: the scheduler's live and paused execution filters ignore `role`, so any live spec execution also blocks promotion and claim of the task (PR #24, #27).
- GOT.38: `PUT /spec/draft` takes `{ content }`. `/spec/revise` returns 409 `DRAFT_EXISTS` when a draft already exists, and no route deletes a draft (PR #27).
- GOT.42: `GET /stream` has no publisher for `notification` events; notifications are rows in their own table and never reach `NOTIFY` (user decision Q7, PR #26). The issue views must poll or refetch.
- GOT.47: `send_message` on an issue carries `{ issue_id, text }` and `resume_with_decision` carries `{ issue_id, decision_id }`. Both are enqueued only while the execution is WAITING_FOR_USER; a message on a non-blocking issue is refused with 409 (PR #28).
- GOT.47: resolving as `spec_revision` leaves the execution WAITING_FOR_USER and enqueues nothing; `/spec/approve` later enqueues `resume_with_revision` (PR #27, #28).
- GOT.42: broadcast notifications (`user_id` null) share one `read_at` across users; one user's read marks it read for all (PR #28, accepted as designed).
- GOT.38/42: `GET /stream` has no replay (user decision Q8); every view must refetch when the stream reconnects. Reuse `apps/web/src/board/useEventReconnect.ts` and the `useLatestRequest` stale-response guard from PR #30 (PR #26, #30).
- GOT.38/42: never put `?after=` in the URL given to `useEventStream`; the hook appends its own `after=` on reconnect and the api rejects a doubled param with 400. Subscribe with the bare URL before loading pages and merge by event id, as `TaskDetailView` does (PR #33). Pass `types` explicitly (PR #18).
- GOT.38/42: a routed view that keeps state must key its stateful panel on the route param, or in-app navigation between two ids keeps the old state; see `TaskDetailView` (PR #33).
- GOT.38/42: the web api client's typed methods live in `apps/web/src/api/types.ts` and `client.ts` (`BoardApiClient`); extend them there and update the typed fake in `apps/web/src/task/fixtures.ts`. `AppLayout` owns the client instance. Run `cd apps/web && npx tsc --noEmit -p tsconfig.json` as well as the root typecheck: the root build excludes web test files (PR #30, #33).
- GOT.38: `@orchestra/prompts` is a web dependency for `renderSpecMarkdown` and `diffSpecs` (user decision Q13, PR #33).
- GOT.39: `StartRequest.testCommand` carries the repository test command to the review role and must be a single plain command. The wrapper reads it from `context.review_command`; where that value comes from is design OI3 and needs a decision.
- GOT.39: the runner must prepend `packages/review-wrapper/bin` to the agent's PATH (user decision Q7, no bundler) and invoke `orchestra-review --round N` after `report_review_started(N)`. Read the exit code, not stdout, for the outcome: 0 clean, 1 findings, 2 ask_user, 3 error. The round-limit stop instruction from `report_review_result` reaches the agent only on the wrapper's stderr (PR #29).
- GOT.39: the wrapper calls `report_review_result` itself, so the implementing agent must not call it again for the same round (PR #29).
- GOT.31: `.orchestra/context.json` now requires `runtime`; the worktree manager writes it from its input (PR #29).
- GOT.44: `report_usage` records one `execution_usage` row per review round with `kind = review`; a multi-model session reports its models comma-joined in `model` (PR #29).
- GOT.48: the wrapper has not been run against real Claude. Tests use a fake adapter and an in-process MCP server. The first live run needs a running worker, an execution token and Claude credentials on the host (PR #29).
- GOT.48 and GOT.49: need a sandbox GitHub repository, a Jira project, and credentials from the user.
