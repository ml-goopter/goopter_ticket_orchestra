import path from "node:path";
import {
  ClaudeAdapter,
  CodexAdapter,
  type AgentAdapter,
  type AgentProcess,
  type ProcessSpawner,
} from "@orchestra/adapters";
import type { Runtime } from "@orchestra/core";
import type { RunnerContext } from "@orchestra/db";
import { DockerError, type ContainerManager } from "../containers/index.js";

/**
 * Container mode in the runner (design.md §9.9, D20, C4): what the runner
 * needs from the container stack, the container's environment, and the
 * adapters that launch every process of an execution in its container.
 */

/** The `ContainerManager` methods the runner uses. Tests inject a fake. */
export type RunnerContainerOps = Pick<
  ContainerManager,
  "ensure" | "remove" | "removeIf" | "runShell" | "spawner" | "agentHome"
>;

/** Long-lived credentials a container may receive (§9.9 Environment). */
export interface RunnerContainerCredentials {
  githubToken?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN`, preferred Claude auth (§9.9 Auth). */
  claudeCodeOauthToken?: string;
  /** `ANTHROPIC_API_KEY`, the fallback when no OAuth token is set. */
  anthropicApiKey?: string;
  /** `OPENAI_API_KEY`, for Codex executions only. */
  openaiApiKey?: string;
}

export interface ContainerAdapterOptions {
  /** Runs every process in the execution's container. */
  spawn: ProcessSpawner;
  /** `<workspace_root>/agent-home/<task id>`: the container's `$HOME`. */
  home: string;
}

/** Builds an adapter that runs in a container; unaware of Docker itself. */
export type ContainerAdapterFactory = (
  runtime: Runtime,
  options: ContainerAdapterOptions,
) => AgentAdapter;

/**
 * The container stack of a worker with the `docker` capability. A runner
 * without it never touches Docker, and fails a container-mode execution
 * as `adapter_error`, retriable.
 */
export interface RunnerContainers {
  manager: RunnerContainerOps;
  /** The agent-tools container listener URL (§9.9 Network). */
  toolsUrl: () => string;
  credentials: RunnerContainerCredentials;
  /** Defaults to `createContainerAdapter`. */
  adapterFor?: ContainerAdapterFactory;
  /** Bound on `setup_command` in the container. Defaults to `quietTimeoutMs`. */
  setupTimeoutMs?: number;
}

/** True when the execution's repository runs its agents in a container. */
export function isContainerMode(ctx: RunnerContext): boolean {
  return ctx.repository?.agentContainer === true;
}

/** `repositories.agent_image`; null or blank means the configured default. */
export function agentImageFor(ctx: RunnerContext): string | null {
  return ctx.repository?.agentImage?.trim() || null;
}

/**
 * §9.9 Environment: the container's variables, by value, passed to
 * `ContainerManager.ensure`. Nothing else from the worker enters: no
 * `DATABASE_URL`, no Jira credentials. `HOME` is set by the manager, `PATH`
 * is the image's, and `ORCHESTRA_TOKEN` travels with each turn's exec.
 * `ensure` also writes the Claude credential chosen here into the
 * container's credential file (§9.9 Auth), so the two always agree.
 */
export function containerEnv(
  ctx: RunnerContext,
  containers: Pick<RunnerContainers, "toolsUrl" | "credentials">,
): Record<string, string> {
  const { credentials } = containers;
  const env: Record<string, string> = { ORCHESTRA_URL: containers.toolsUrl() };
  if (credentials.githubToken) env.GITHUB_TOKEN = credentials.githubToken;
  if (credentials.claudeCodeOauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeCodeOauthToken;
  } else if (credentials.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = credentials.anthropicApiKey;
  }
  if (ctx.execution.runtime === "codex" && credentials.openaiApiKey) {
    env.OPENAI_API_KEY = credentials.openaiApiKey;
  }
  return env;
}

/** The Claude session stores under the agent home (`$HOME/.claude/projects`). */
export function claudeSessionRoot(home: string): string {
  return path.join(home, ".claude", "projects");
}

/** The Codex session store under the agent home (`$HOME/.codex/sessions`). */
export function codexSessionRoot(home: string): string {
  return path.join(home, ".codex", "sessions");
}

/** The Claude CLI on the image's PATH (§9.9 Image). */
export const CLAUDE_CONTAINER_COMMAND = "claude";

/** A script entry point: the SDK is running the CLI through a JavaScript runtime. */
const SCRIPT_ENTRY = /\.(?:js|mjs|cjs)$/i;

/**
 * The SDK launches the Claude CLI binary it resolved on the host, a path
 * that does not exist in the container. Runs the image's `claude` with the
 * SDK's arguments instead. That is only right for the SDK's native form,
 * a `claude` binary whose arguments are the CLI's own; any other form (a
 * runtime running a `.js` entry point, or another binary) throws, so an
 * SDK change fails loudly instead of running the wrong command (C4 F3).
 */
export function claudeContainerSpawner(spawn: ProcessSpawner): ProcessSpawner {
  return (command, args, options) => {
    const first = args[0];
    if (path.basename(command) !== CLAUDE_CONTAINER_COMMAND || (first !== undefined && SCRIPT_ENTRY.test(first))) {
      throw new Error(
        `unexpected Claude CLI launch from the agent SDK: ${JSON.stringify(command)} ` +
          `${JSON.stringify(first ?? "")}; container mode runs only the native \`claude\` binary`,
      );
    }
    return spawn(CLAUDE_CONTAINER_COMMAND, args, options);
  };
}

/**
 * The default `ContainerAdapterFactory`: the runtime's adapter with the
 * container spawner and the session stores under the agent home, so
 * `canResume` looks at the container's sessions.
 */
export function createContainerAdapter(
  runtime: Runtime,
  options: ContainerAdapterOptions,
  extra: { codexDebug?: (reason: string, line: string) => void } = {},
): AgentAdapter {
  if (runtime === "codex") {
    return new CodexAdapter({
      spawn: options.spawn,
      sessionRoot: codexSessionRoot(options.home),
      ...(extra.codexDebug ? { debug: extra.codexDebug } : {}),
    });
  }
  return new ClaudeAdapter({
    spawn: claudeContainerSpawner(options.spawn),
    sessionRoot: claudeSessionRoot(options.home),
  });
}

/**
 * Wraps a spawner so a `DockerError` from starting a process or from its
 * exit reaches `onDockerError`. The adapter still sees the process as
 * before; the runner uses the record to classify the turn (§9.9
 * Scheduling: Docker failing mid-execution is `adapter_error`, retriable).
 */
export function observeDockerErrors(
  spawn: ProcessSpawner,
  onDockerError: (err: DockerError) => void,
): ProcessSpawner {
  return (command, args, options) => {
    let proc: AgentProcess;
    try {
      proc = spawn(command, args, options);
    } catch (err) {
      if (err instanceof DockerError) onDockerError(err);
      throw err;
    }
    proc.exit.catch((err: unknown) => {
      if (err instanceof DockerError) onDockerError(err);
    });
    return proc;
  };
}

/** Message for a container-mode execution on a worker without Docker. */
export const NO_DOCKER_MESSAGE =
  "repository runs in container mode (agent_container) but this worker has no docker capability";
