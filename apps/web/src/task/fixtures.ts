import { vi } from "vitest";
import type { SpecApiClient } from "../api/client.js";
import type {
  Execution,
  Issue,
  IssueDetail,
  IssueMessage,
  PullRequest,
  ReviewResult,
  SpecificationApproval,
  SpecificationRevision,
  TaskAggregate,
  TaskDecision,
  TimelineEvent,
} from "../api/types.js";

/**
 * One shared seeded aggregate for tests (AC2), mirroring the api test
 * seed in `apps/api/test/tasks.test.ts` (GOT.41): two revisions, one
 * approval, two executions (spec + implementation), one issue with a
 * decision, one review result, and a PR.
 */
const specContent = {
  repository: "tsk-repo",
  objective: "v2 objective",
  scope: ["a", "b"],
  out_of_scope: [],
  requirements: ["r1", "r2"],
  acceptance_criteria: ["ac1"],
  validation: ["v1"],
  constraints: [],
  dependencies: [],
};

const revisionV1: SpecificationRevision = {
  id: "rev-1",
  taskId: "task-1",
  version: 1,
  status: "superseded",
  content: { ...specContent, objective: "v1 objective", scope: ["a"], requirements: ["r1"] },
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const revisionV2: SpecificationRevision = {
  id: "rev-2",
  taskId: "task-1",
  version: 2,
  status: "approved",
  content: specContent,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:30:00.000Z",
  updatedAt: "2026-01-01T00:30:00.000Z",
};

const approval: SpecificationApproval = {
  id: "approval-1",
  revisionId: "rev-2",
  approvedBy: "user-1",
  approvedAt: "2026-01-02T00:00:00.000Z",
  runtime: "claude",
};

const specExecution: Execution = {
  id: "exec-spec-1",
  taskId: "task-1",
  role: "spec",
  attempt: 1,
  state: "COMPLETED",
  runtime: "claude",
  model: "claude-sonnet-5",
  specRevisionId: null,
  workerId: null,
  host: "worker-1",
  worktreePath: null,
  branch: null,
  sessionId: "session-spec-1",
  toolsTokenHash: null,
  endReason: null,
  endDetail: null,
  reviewRounds: 0,
  ciRounds: 0,
  infraRetriesUsed: 0,
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 200,
  costUsd: "0.500000",
  worktreeEvictedAt: null,
  startedAt: "2026-01-01T01:00:00.000Z",
  endedAt: "2026-01-01T01:10:00.000Z",
  createdAt: "2026-01-01T01:00:00.000Z",
};

const implExecution: Execution = {
  id: "exec-impl-1",
  taskId: "task-1",
  role: "implementation",
  attempt: 1,
  state: "RUNNING",
  runtime: "claude",
  model: "claude-sonnet-5",
  specRevisionId: "rev-2",
  workerId: null,
  host: "worker-1",
  worktreePath: "/work/task-1",
  branch: "tsk-70",
  sessionId: "session-impl-1",
  toolsTokenHash: null,
  endReason: null,
  endDetail: null,
  reviewRounds: 1,
  ciRounds: 0,
  infraRetriesUsed: 0,
  inputTokens: 5000,
  cachedInputTokens: 500,
  outputTokens: 2000,
  costUsd: "2.500000",
  worktreeEvictedAt: null,
  startedAt: "2026-01-01T02:00:00.000Z",
  endedAt: null,
  createdAt: "2026-01-01T02:00:00.000Z",
};

const issue: Issue = {
  id: "issue-1",
  taskId: "task-1",
  executionId: "exec-impl-1",
  type: "QUESTION",
  severity: "blocking",
  blocking: true,
  title: "Which pagination style?",
  description: "Cursor or offset?",
  question: "Cursor or offset?",
  suggestedOptions: null,
  recommendedOption: null,
  status: "RESOLVED",
  resolutionKind: "clarification",
  resolution: "Use cursor pagination.",
  resolvedBy: "user-1",
  createdAt: "2026-01-01T02:05:00.000Z",
  resolvedAt: "2026-01-02T01:00:00.000Z",
};

/**
 * A seeded blocking, OPEN issue with a question, two suggested options and
 * a recommendation (AC2), distinct from the `RESOLVED` `issue` fixture
 * embedded in `makeTaskAggregate()` above.
 */
const openIssue: Issue = {
  id: "issue-2",
  taskId: "task-1",
  executionId: "exec-impl-1",
  type: "DECISION_REQUIRED",
  severity: "blocking",
  blocking: true,
  title: "Which pagination style?",
  description: "The existing api supports both cursor and offset pagination.",
  question: "Cursor or offset pagination?",
  suggestedOptions: [
    { id: "cursor", description: "Cursor-based pagination.", tradeoff: "Cannot jump to an arbitrary page." },
    { id: "offset", description: "Offset-based pagination.", tradeoff: "Slower on large tables." },
  ],
  recommendedOption: "cursor",
  status: "OPEN",
  resolutionKind: null,
  resolution: null,
  resolvedBy: null,
  createdAt: "2026-01-01T02:05:00.000Z",
  resolvedAt: null,
};

const openIssueMessage: IssueMessage = {
  id: "msg-1",
  issueId: "issue-2",
  authorKind: "user",
  userId: "user-1",
  body: "Any preference on pagination?",
  createdAt: "2026-01-01T02:06:00.000Z",
};

export function makeIssueDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    issue: openIssue,
    messages: [openIssueMessage],
    execution: { id: "exec-impl-1", role: "implementation", state: "WAITING_FOR_USER", runtime: "claude" },
    task: { id: "task-1", jira_key: "TSK-70", state: "IMPLEMENTING" },
    decision: null,
    ...overrides,
  };
}

const decision: TaskDecision = {
  id: "decision-1",
  taskId: "task-1",
  issueId: "issue-1",
  decision: "Use cursor pagination.",
  clarification: null,
  chosenOption: null,
  decidedBy: "user-1",
  decidedAt: "2026-01-02T01:00:00.000Z",
};

const reviewResult: ReviewResult = {
  id: "review-1",
  executionId: "exec-impl-1",
  round: 1,
  verdict: "findings",
  findings: [
    {
      severity: "warning",
      file: "src/index.ts",
      line: 10,
      description: "Missing null check.",
      action: "Add a guard.",
    },
  ],
  reviewerRuntime: "claude",
  usageId: null,
  createdAt: "2026-01-02T02:00:00.000Z",
};

const pullRequest: PullRequest = {
  id: "pr-1",
  taskId: "task-1",
  number: 42,
  url: "https://github.com/goopter/tsk-repo/pull/42",
  headSha: "abc123",
  state: "open",
  ciState: "running",
  ciDetail: null,
  lastPolledAt: "2026-01-02T03:00:00.000Z",
  createdAt: "2026-01-02T02:30:00.000Z",
  mergedAt: null,
};

export function makeTaskAggregate(
  overrides: Partial<TaskAggregate> = {},
): TaskAggregate {
  return {
    task: {
      id: "task-1",
      projectId: "project-1",
      repositoryId: "repo-1",
      jiraKey: "TSK-70",
      jiraSummary: "Add pagination to the timeline",
      jiraPriority: 5,
      jiraCreatedAt: "2026-01-01T00:00:00.000Z",
      jiraSyncedAt: "2026-01-01T00:00:00.000Z",
      state: "IMPLEMENTING",
      runtimeOverride: null,
      approvedRevisionId: "rev-2",
      needsHumanReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T03:00:00.000Z",
    },
    project: {
      id: "project-1",
      key: "TSK",
      name: "TSK project",
      jiraJql: "project = TSK",
      maxInfraRetries: 3,
      maxProtocolRetries: 2,
      maxCiRounds: 3,
      maxReviewRounds: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    repository: {
      id: "repo-1",
      projectId: "project-1",
      name: "tsk-repo",
      gitUrl: "git@example.com:goopter/tsk-repo.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    approvedRevision: revisionV2,
    latestExecutions: { spec: specExecution, implementation: implExecution },
    openIssueCount: 0,
    pullRequest,
    revisions: [revisionV1, revisionV2],
    approvals: [approval],
    executions: [specExecution, implExecution],
    issues: [issue],
    decisions: [decision],
    reviewResults: [reviewResult],
    dependencies: [],
    cost: {
      costUsd: 3,
      inputTokens: 6000,
      cachedInputTokens: 500,
      outputTokens: 2200,
    },
    ...overrides,
  };
}

export function makeTimelineEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    taskId: "task-1",
    executionId: null,
    type: "agent.note",
    payload: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A fully-typed `SpecApiClient` double (a `BoardApiClient` plus the
 * GOT.42 issue detail methods and the GOT.38 spec builder methods) with
 * every method a no-op `vi.fn()`, so a test only has to override the
 * handful of methods it exercises rather than restate the whole interface
 * (GOT.41-fix0).
 */
export function makeFakeClient(overrides: Partial<SpecApiClient> = {}): SpecApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    health: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    markNotificationRead: vi.fn(),
    getTask: vi.fn().mockResolvedValue(makeTaskAggregate()),
    getTimeline: vi.fn().mockResolvedValue({ events: [], nextAfter: 0 }),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    getIssue: vi.fn().mockResolvedValue(makeIssueDetail()),
    postIssueMessage: vi.fn(),
    resolveIssue: vi.fn(),
    listProjectRepositories: vi.fn().mockResolvedValue([]),
    startSpecSession: vi.fn(),
    postSpecMessage: vi.fn(),
    saveDraft: vi.fn(),
    requestReview: vi.fn(),
    sendBack: vi.fn(),
    approveSpec: vi.fn(),
    reviseSpec: vi.fn(),
    ...overrides,
  };
}
