import type { Runtime } from "@orchestra/core";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
  ToolPolicy,
  UsageBaseline,
} from "./types.js";

/**
 * Compile-only contract fixture for the adapter surface (design.md §7).
 *
 * This file is inside `tsconfig.json`'s `include`, so `tsc -b` type-checks it
 * on every build. The `*.test.ts` files are excluded from that build, which is
 * why the field-for-field assertions live here rather than in a test: a
 * `expectTypeOf` call in an excluded file is never checked by anything and
 * passes no matter how the type drifts.
 *
 * Three things are pinned:
 *
 *  - `Exact<A, B>` equality assertions for every §7 type, which fail the build
 *    on a renamed, added, removed, retyped or newly optional field.
 *  - `AGENT_EVENT_SAMPLES` and the request samples, values carrying exactly
 *    the fields §7 lists.
 *  - `agentEventTypeOf` switches exhaustively and assigns the fall-through to
 *    `never`, so a new union member fails the build until it is handled.
 */

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * Invariant type equality. Two conditional types are assignable to each other
 * only when their checked types are identical, so unlike `extends` this
 * rejects a widened, narrowed or extra field in either direction.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type ToolPolicyIsTheThreeRoles = Assert<
  Exact<ToolPolicy, "implementation" | "spec" | "review">
>;

export type StartRequestHasExactlyTheseFields = Assert<
  Exact<
    StartRequest,
    {
      cwd: string;
      systemPrompt: string;
      prompt: string;
      model?: string;
      allowedTools: ToolPolicy;
      mcp: { url: string; token: string };
      env: Record<string, string>;
      maxBudgetUsd?: number;
      testCommand?: string;
    }
  >
>;

export type ResumeRequestHasExactlyTheseFields = Assert<
  Exact<
    ResumeRequest,
    {
      cwd: string;
      prompt: string;
      model?: string;
      allowedTools: ToolPolicy;
      mcp: { url: string; token: string };
      env: Record<string, string>;
      maxBudgetUsd?: number;
      testCommand?: string;
      sessionId: string;
      usageBaseline?: UsageBaseline;
    }
  >
>;

/** A resume carries no system prompt: the session already has one (§7). */
export type ResumeRequestHasNoSystemPrompt = Assert<
  Exact<"systemPrompt" extends keyof ResumeRequest ? true : false, false>
>;

export type UsageBaselineHasExactlyTheseFields = Assert<
  Exact<
    UsageBaseline,
    Record<
      string,
      { input: number; cached: number; output: number; costUsd?: number }
    >
  >
>;

export type AgentAdapterHasExactlyThisSurface = Assert<
  Exact<
    AgentAdapter,
    {
      readonly runtime: Runtime;
      start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
      resume(
        req: ResumeRequest,
        signal: AbortSignal,
      ): AsyncIterable<AgentEvent>;
      canResume(sessionId: string, cwd: string): Promise<boolean>;
    }
  >
>;

export type AgentEventUnionIsExactlyThis = Assert<
  Exact<
    AgentEvent,
    | { type: "session"; sessionId: string }
    | { type: "text"; delta: string }
    | { type: "tool_call"; name: string; input: unknown }
    | { type: "tool_result"; name: string; ok: boolean }
    | {
        type: "usage";
        model: string;
        input: number;
        cached: number;
        output: number;
        costUsd?: number;
      }
    | { type: "turn_done"; finalText: string }
    | { type: "error"; message: string; retriable: boolean }
  >
>;

/** One fully populated value per request type (design.md §7). */
export const START_REQUEST_SAMPLE: StartRequest = {
  cwd: "/work/exec-1",
  systemPrompt: "You are the implementer.",
  prompt: "Implement GOT-1.",
  model: "claude-sonnet-5",
  allowedTools: "implementation",
  mcp: { url: "http://127.0.0.1:4599/mcp", token: "t" },
  env: { ORCHESTRA_TOKEN: "t" },
  maxBudgetUsd: 5,
  // `testCommand` is deliberately absent: it is an optional extension of §7
  // (design.md §7.1's review-only test-command grant), and `types.test.ts`
  // pins this sample's field set to exactly the base §7 shape.
};

export const RESUME_REQUEST_SAMPLE: ResumeRequest = {
  cwd: START_REQUEST_SAMPLE.cwd,
  prompt: START_REQUEST_SAMPLE.prompt,
  model: START_REQUEST_SAMPLE.model,
  allowedTools: START_REQUEST_SAMPLE.allowedTools,
  mcp: START_REQUEST_SAMPLE.mcp,
  env: START_REQUEST_SAMPLE.env,
  maxBudgetUsd: START_REQUEST_SAMPLE.maxBudgetUsd,
  sessionId: "11111111-2222-3333-4444-555555555555",
  usageBaseline: {
    "claude-sonnet-5": { input: 1, cached: 2, output: 3, costUsd: 0.5 },
  },
};
export const AGENT_EVENT_SAMPLES: readonly AgentEvent[] = [
  { type: "session", sessionId: "11111111-2222-3333-4444-555555555555" },
  { type: "text", delta: "hello" },
  { type: "tool_call", name: "Read", input: { file_path: "/a" } },
  { type: "tool_result", name: "Read", ok: true },
  { type: "usage", model: "claude-sonnet-5", input: 1, cached: 2, output: 3 },
  { type: "turn_done", finalText: "done" },
  { type: "error", message: "boom", retriable: false },
];

export function agentEventTypeOf(event: AgentEvent): AgentEvent["type"] {
  switch (event.type) {
    case "session":
      return event.type;
    case "text":
      return event.type;
    case "tool_call":
      return event.type;
    case "tool_result":
      return event.type;
    case "usage":
      return event.type;
    case "turn_done":
      return event.type;
    case "error":
      return event.type;
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled agent event: ${JSON.stringify(unhandled)}`);
    }
  }
}
