# Build order

Execution order for the tracker tasks (GOT.10 to GOT.49). It refines docs/design.md §16 into waves: tasks in one wave have their dependencies met and own disjoint paths, so up to two run in parallel. Each task's plan and spec is approved by the user before dispatch (CLAUDE.md, workflow step 2).

Status as of 2026-09-25, main at `d15274a` plus this change.

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

Fixes and process changes: #11 drizzle boundary, #13 hotfix, #16 severity rule, #17 agent-tools lock order and lease, #18 review test command and SSE, #19 per-task approval, #20 login timing, free slots, user patch.

## Remaining

Order within a wave is priority order. Critical path: GOT.31 → GOT.39 → GOT.46 and GOT.47 → GOT.48 → GOT.49.

| Wave | Task | Title | Depends on | Milestone |
| --- | --- | --- | --- | --- |
| W5 | GOT.26 | worker: scheduler phases, claim, leases, capacity | GOT.16, 19 | M6 |
| W5 | GOT.28 | api: LISTEN connection and SSE endpoints | GOT.21 | M3 |
| W5 | GOT.32 | api: specification routes | GOT.21 | M5 |
| W5 | GOT.33 | api: issue routes, resolution, notifications | GOT.21 | M7 |
| W5 | GOT.40 | review-wrapper: orchestra-review binary | GOT.14, 24 | M6 |
| W6 | GOT.31 | worker: execution runner loop and command consumer | GOT.14, 15, 24, 25 | M5 |
| W6 | GOT.36 | web: board view and attention drawer | GOT.21, 22, 28 | M3 |
| W6 | GOT.41 | web: task detail timeline and side panel | GOT.21, 22, 28 | M6 |
| W6 | GOT.34 | worker: lease sweeper and dead-host release | GOT.26 | M8 |
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

- GOT.31: lease renewal must go through the state-gated db helper; a runner-supplied `renewLease` that bypasses it can renew a cancelled execution. Every transaction that locks both rows takes the task row before the execution row (PR #17).
- GOT.31: the worktree manager's setup command inherits the full worker environment (database URL, tokens, API keys) and has no timeout. Both were deferred to this task by user decision (PR #22).
- GOT.31: a `WorktreeManager.prepareImplementation` call must follow the end of any earlier session for the same task, because a stale worktree holding the task branch is detached (PR #22).
- GOT.31: run `pnpm typecheck` (or build) before `pnpm test` in a fresh checkout. Worker tests load workspace packages from `dist`, and a stale `dist` fails tests unrelated to the change.
- GOT.26 is in progress: user decisions Q4 promotion included, Q5 `executions.model = 'default'` when the repository has none, Q6 `BLOCKED → READY` left out.
- GOT.31: `renewTaskLease` refuses WAITING_FOR_USER by design (D5 frees the slot); the §6.4 heartbeat must not expect otherwise.
- GOT.36: the SSE hook's default event types are cast to the caller's type parameter; pass `types` explicitly for dashboard events (PR #18, accepted minor).
- GOT.40: `StartRequest.testCommand` carries the repository test command to the review role and must be a single plain command. Where the value comes from is design OI3 and needs a decision.
- GOT.48 and GOT.49: need a sandbox GitHub repository, a Jira project, and credentials from the user.
