import path from "node:path";
import fs from "node:fs/promises";
import {
  ClaudeAdapter,
  type AgentAdapter,
  type StartRequest,
} from "@orchestra/adapters";
import {
  EXECUTION_CONTEXT_PATH,
  ExecutionContextSchema,
  type ExecutionContext,
  type ReviewFindingsDocument,
} from "@orchestra/core";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "@orchestra/prompts";
import { parseRound } from "./args.js";
import { ExitCode, ReviewError } from "./errors.js";
import { collectChanges, runGit, type GitRunner } from "./git.js";
import { parseReviewReply } from "./reply.js";
import { createMcpReporter, type ReviewReporter } from "./reporter.js";

/** C1: the Codex adapter is not built yet. */
export const CODEX_UNAVAILABLE_MESSAGE =
  "codex runtime is not available until the Codex adapter lands (GOT.45)";

/** Model reported when the session emitted no usage event. */
const UNKNOWN_MODEL = "unknown";

export interface RunDeps {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** Worktree root. */
  cwd: string;
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void | Promise<void>;
  git?: GitRunner;
  /** Reads a file as utf8. Only context.json and untracked files go through it. */
  readFile?: (file: string) => Promise<string>;
  createAdapter?: (runtime: "claude") => AgentAdapter;
  createReporter?: (url: string, token: string) => ReviewReporter;
  signal?: AbortSignal;
}

interface SessionResult {
  finalText: string;
  usage: {
    model: string;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

/**
 * `orchestra-review` (design.md §9.8). Returns the exit code: 0 clean,
 * 1 findings, 2 ask_user, 3 any error. Stdout carries only the validated
 * findings document; every diagnostic goes to stderr.
 */
export async function runReview(deps: RunDeps): Promise<number> {
  const say = async (message: string) => {
    await deps.stderr(`orchestra-review: ${message}\n`);
  };

  try {
    const round = parseRound(deps.argv);
    const url = requireEnv(deps.env, "ORCHESTRA_URL");
    const token = requireEnv(deps.env, "ORCHESTRA_TOKEN");
    const readFile = deps.readFile ?? ((file: string) => fs.readFile(file, "utf8"));

    const context = await readContext(deps.cwd, readFile);
    if (context.runtime === "codex") {
      throw new ReviewError(CODEX_UNAVAILABLE_MESSAGE);
    }

    const changes = await collectChanges(deps.cwd, context.repository.default_branch, {
      git: deps.git ?? runGit,
      readFile,
    });

    const prompt = buildReviewPrompt({
      spec: context.spec,
      decisions: context.decisions.map((d) => ({
        issueId: d.issue_id,
        decision: d.decision,
        clarification: d.clarification,
        chosenOption: d.chosen_option,
        author: d.decided_by,
        decidedAt: d.decided_at,
      })),
      diff: changes.diff,
      untracked: changes.untracked,
      repository: {
        name: context.repository.name,
        defaultBranch: context.repository.default_branch,
        branch: context.repository.branch,
      },
      testCommand: context.review_command,
    });

    const request: StartRequest = {
      cwd: deps.cwd,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      prompt,
      allowedTools: "review",
      mcp: { url, token },
      env: sessionEnv(deps.env),
    };
    if (context.review_command !== null) request.testCommand = context.review_command;

    const adapter = (deps.createAdapter ?? (() => new ClaudeAdapter()))(context.runtime);
    const session = await runSession(
      adapter,
      request,
      deps.signal ?? new AbortController().signal,
    );
    const document = parseReviewReply(session.finalText);

    await deps.stdout(`${JSON.stringify(document)}\n`);

    const reporter = (deps.createReporter ?? createMcpReporter)(url, token);
    try {
      return await report(reporter, round, document, session, say);
    } finally {
      await reporter.close();
    }
  } catch (error) {
    await say(error instanceof Error ? error.message : String(error));
    return ExitCode.error;
  }
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ReviewError(`${name} is not set`);
  }
  return value;
}

async function readContext(
  cwd: string,
  readFile: (file: string) => Promise<string>,
): Promise<ExecutionContext> {
  const file = path.join(cwd, EXECUTION_CONTEXT_PATH);
  let raw: string;
  try {
    raw = await readFile(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReviewError(`cannot read ${EXECUTION_CONTEXT_PATH}: ${detail}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ReviewError(`${EXECUTION_CONTEXT_PATH} is not valid JSON`);
  }
  const parsed = ExecutionContextSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReviewError(
      `${EXECUTION_CONTEXT_PATH} does not match the execution context schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The caller's environment minus the execution token. */
function sessionEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== "ORCHESTRA_TOKEN") out[key] = value;
  }
  return out;
}

/**
 * Drives one fresh review session to its `turn_done`. Usage events are
 * summed; an `error` event or a thrown adapter error fails the run.
 */
async function runSession(
  adapter: AgentAdapter,
  request: StartRequest,
  signal: AbortSignal,
): Promise<SessionResult> {
  const models: string[] = [];
  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  let finalText: string | undefined;

  try {
    for await (const event of adapter.start(request, signal)) {
      if (event.type === "usage") {
        if (!models.includes(event.model)) models.push(event.model);
        usage.input_tokens += event.input;
        usage.cached_input_tokens += event.cached;
        usage.output_tokens += event.output;
        usage.cost_usd += event.costUsd ?? 0;
      } else if (event.type === "error") {
        throw new ReviewError(`review session failed: ${event.message}`);
      } else if (event.type === "turn_done") {
        finalText = event.finalText;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReviewError(`review session failed: ${detail}`);
  }

  if (finalText === undefined) {
    throw new ReviewError("review session ended without a final reply");
  }
  return {
    finalText,
    usage: { model: models.length > 0 ? models.join(",") : UNKNOWN_MODEL, ...usage },
  };
}

/**
 * `report_usage` then `report_review_result` with the usage id. A failed
 * `report_usage` still reports the result, without `usage_id`, and the run
 * exits 3. A failed `report_review_result` exits 3.
 */
async function report(
  reporter: ReviewReporter,
  round: number,
  document: ReviewFindingsDocument,
  session: SessionResult,
  say: (message: string) => Promise<void>,
): Promise<number> {
  let usageId: string | undefined;
  let failed = false;
  try {
    usageId = await reporter.reportUsage({ kind: "review", round, ...session.usage });
  } catch (error) {
    failed = true;
    await say(error instanceof Error ? error.message : String(error));
  }

  try {
    const result = await reporter.reportReviewResult({
      round,
      verdict: document.verdict,
      findings: document.findings,
      ...(usageId === undefined ? {} : { usage_id: usageId }),
    });
    // The agent-tools server stops the loop through this instruction
    // (design.md §8 round limit); stdout stays the findings document only.
    if (result.instruction) await say(result.instruction);
  } catch (error) {
    await say(error instanceof Error ? error.message : String(error));
    return ExitCode.error;
  }

  return failed ? ExitCode.error : ExitCode[document.verdict];
}
