import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type {
  AgentProcess,
  ProcessExit,
  ProcessSpawner,
  ProcessSpawnOptions,
} from "@orchestra/adapters";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_NETWORK,
  ContainerManager,
  DockerError,
  EXECUTION_LABEL,
  OWNER_LABEL,
  TASK_LABEL,
  containerName,
  createDockerRunner,
  dockerExecutionContainers,
  ensureMark,
  withExecutionContainerLock,
  type DockerResult,
  type DockerRunOptions,
  type DockerRunner,
} from "../src/containers/index.js";

/**
 * Unit tests for the agent container module (design.md §9.9) with an
 * injected fake docker runner and a fake exec client. Real Docker is
 * exercised in `containers-docker.test.ts`.
 */

const EXEC = "11111111-2222-4333-8444-555555555555";
const TASK = "66666666-7777-4888-9999-000000000000";
const IMAGE = "orchestra/agent:0.0.1";
const OWNER = "0123456789abcdef0123456789abcdef";
const SECRET_GH = "ghp_SECRETVALUE_github";
const SECRET_CLAUDE = "sk-ant-oat-SECRETVALUE_claude";
const SECRET_TURN = "orchestra-turn-SECRETVALUE";

let tmp: string;
let root: string;

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-containers-unit-")));
});

afterAll(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

let rootSeq = 0;
beforeEach(() => {
  root = path.join(tmp, `ws-${++rootSeq}`);
});

// ---------------------------------------------------------------- fakes

interface Call {
  args: string[];
  options: DockerRunOptions;
}

type Reply = Partial<DockerResult> | Error | undefined;

const NOT_FOUND: Reply = {
  exitCode: 1,
  stderr: `Error response from daemon: No such container: orchestra-exec-${EXEC}\n`,
};
const NETWORK_OK: Reply = {
  exitCode: 0,
  stdout: '[{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]\n',
};
const RUNNING: Reply = {
  exitCode: 0,
  stdout: '{"Status":"running","Running":true,"Paused":false,"Restarting":false}\n',
};
const EXITED: Reply = {
  exitCode: 0,
  stdout: '{"Status":"exited","Running":false,"Paused":false,"Restarting":false}\n',
};

function fakeDocker(handler: (args: string[], call: number) => Reply = () => undefined) {
  const calls: Call[] = [];
  const run: DockerRunner = async (args, options) => {
    calls.push({ args: [...args], options });
    const reply = handler([...args], calls.length - 1);
    if (reply instanceof Error) throw reply;
    return { exitCode: 0, stdout: "", stderr: "", ...reply };
  };
  return { run, calls, verbs: () => calls.map((c) => c.args.slice(0, 2).join(" ")) };
}

/**
 * Replies for a first `ensure` on a host where the network exists. Once
 * `run -d` has replied, a later `container inspect` (the post-create check)
 * reports the container running, as the real daemon would.
 */
function freshHost(overrides: (args: string[]) => Reply = () => undefined) {
  let started = false;
  return (args: string[]): Reply => {
    const o = overrides(args);
    if (o !== undefined) return o;
    if (args[0] === "container" && args[1] === "inspect") return started ? RUNNING : NOT_FOUND;
    if (args[0] === "network" && args[1] === "inspect") return NETWORK_OK;
    if (args[0] === "run") {
      started = true;
      return { stdout: "abc123\n" };
    }
    return undefined;
  };
}

interface FakeClient extends AgentProcess {
  command: string;
  args: string[];
  options: ProcessSpawnOptions;
  killed: string[];
  finish(exit: ProcessExit): void;
  fail(err: Error): void;
}

function fakeSpawner(onKill?: (client: FakeClient, signal: string) => void) {
  const clients: FakeClient[] = [];
  const spawn: ProcessSpawner = (command, args, options) => {
    let finish!: (exit: ProcessExit) => void;
    let fail!: (err: Error) => void;
    const exit = new Promise<ProcessExit>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const client: FakeClient = {
      command,
      args: [...args],
      options,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exit,
      killed: [],
      kill(signal = "SIGKILL") {
        client.killed.push(signal);
        onKill?.(client, signal);
      },
      finish: (e) => {
        (client.stdout as PassThrough).end();
        (client.stderr as PassThrough).end();
        finish(e);
      },
      fail,
    };
    clients.push(client);
    return client;
  };
  return { spawn, clients };
}

function manager(
  run: DockerRunner,
  extra: Partial<ConstructorParameters<typeof ContainerManager>[0]> = {},
) {
  return new ContainerManager({
    workspaceRoot: root,
    image: IMAGE,
    cpus: 2,
    memory: "4g",
    owner: OWNER,
    run,
    uid: 501,
    gid: 20,
    ...extra,
  });
}

const ensureInput = (over: Record<string, unknown> = {}) => ({
  executionId: EXEC,
  taskId: TASK,
  repositoryName: "sample_repo",
  role: "implementation" as const,
  env: { GITHUB_TOKEN: SECRET_GH, CLAUDE_CODE_OAUTH_TOKEN: SECRET_CLAUDE },
  ...over,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------- tests

describe("naming (design.md §9.9 Lifecycle)", () => {
  it("names the container orchestra-exec-<execution id> and uses the documented labels", () => {
    expect(containerName(EXEC)).toBe(`orchestra-exec-${EXEC}`);
    expect(EXECUTION_LABEL).toBe("orchestra.execution");
    expect(TASK_LABEL).toBe("orchestra.task");
    expect(OWNER_LABEL).toBe("orchestra.owner");
    expect(AGENT_NETWORK).toBe("orchestra-agents");
  });
});

describe("ContainerManager.ensure", () => {
  it("creates a missing container with labels, user, limits, network, the three mounts and env by name only", async () => {
    const docker = fakeDocker(freshHost());
    const m = manager(docker.run);

    const handle = await m.ensure(ensureInput());

    const work = path.join(root, "work", EXEC);
    const repo = path.join(root, "repos", "sample_repo.git");
    const home = path.join(root, "agent-home", TASK);
    const run = docker.calls.find((c) => c.args[0] === "run")!;
    expect(run.args).toEqual([
      "run",
      "-d",
      "--name",
      `orchestra-exec-${EXEC}`,
      "--label",
      `orchestra.execution=${EXEC}`,
      "--label",
      `orchestra.task=${TASK}`,
      "--label",
      `orchestra.owner=${OWNER}`,
      "--user",
      "501:20",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--network",
      "orchestra-agents",
      "--pull",
      "never",
      "--mount",
      `type=bind,source=${work},target=${work}`,
      "--mount",
      `type=bind,source=${repo},target=${repo}`,
      "--mount",
      `type=bind,source=${home},target=${home}`,
      "-e",
      `HOME=${home}`,
      "-e",
      "GITHUB_TOKEN",
      "-e",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ]);
    expect(run.options.env).toEqual({
      GITHUB_TOKEN: SECRET_GH,
      CLAUDE_CODE_OAUTH_TOKEN: SECRET_CLAUDE,
    });
    expect(handle).toEqual({
      name: `orchestra-exec-${EXEC}`,
      executionId: EXEC,
      taskId: TASK,
      worktreePath: work,
      home,
      created: true,
    });
    expect(statSync(home).isDirectory()).toBe(true);
  });

  it("always runs sleep infinity via --entrypoint, whatever the image's own ENTRYPOINT or CMD is (F2)", async () => {
    const docker = fakeDocker(freshHost());
    await manager(docker.run).ensure(ensureInput({ image: "registry.local/agent-node:3" }));
    const run = docker.calls.find((c) => c.args[0] === "run")!;
    expect(run.args.slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      "registry.local/agent-node:3",
      "infinity",
    ]);
  });

  it("never puts a secret value on any docker command line", async () => {
    const docker = fakeDocker(freshHost());
    await manager(docker.run).ensure(ensureInput());
    const argv = docker.calls.flatMap((c) => c.args).join(" ");
    expect(argv).not.toContain("SECRETVALUE");
  });

  it("mounts the worktree and bare clone read-only for role spec, the agent home read-write", async () => {
    const docker = fakeDocker(freshHost());
    await manager(docker.run).ensure(ensureInput({ role: "spec" }));

    const work = path.join(root, "work", EXEC);
    const repo = path.join(root, "repos", "sample_repo.git");
    const home = path.join(root, "agent-home", TASK);
    const mounts = docker.calls
      .find((c) => c.args[0] === "run")!
      .args.filter((_, i, a) => a[i - 1] === "--mount");
    expect(mounts).toEqual([
      `type=bind,source=${work},target=${work},readonly`,
      `type=bind,source=${repo},target=${repo},readonly`,
      `type=bind,source=${home},target=${home}`,
    ]);
  });

  it("uses the repository image override, and the configured default for empty or null", async () => {
    const image = async (value: unknown) => {
      const docker = fakeDocker(freshHost());
      await manager(docker.run).ensure(ensureInput({ image: value }));
      return docker.calls.find((c) => c.args[0] === "run")!.args.at(-2);
    };
    expect(await image("registry.local/agent-node:3")).toBe("registry.local/agent-node:3");
    expect(await image("")).toBe(IMAGE);
    expect(await image("   ")).toBe(IMAGE);
    expect(await image(null)).toBe(IMAGE);
    expect(await image(undefined)).toBe(IMAGE);
  });

  it("mounts a caller-supplied worktree path under <root>/work (a retry that took over a worktree)", async () => {
    const docker = fakeDocker(freshHost());
    const other = path.join(root, "work", "aaaaaaaa-0000-4000-8000-000000000000");
    const handle = await manager(docker.run).ensure(ensureInput({ worktreePath: other }));
    expect(handle.worktreePath).toBe(other);
    expect(docker.calls.find((c) => c.args[0] === "run")!.args).toContain(
      `type=bind,source=${other},target=${other}`,
    );
  });

  it("rejects a worktree path outside <root>/work and a repository name that is not a single segment", async () => {
    const docker = fakeDocker(freshHost());
    const m = manager(docker.run);
    await expect(m.ensure(ensureInput({ worktreePath: os.homedir() }))).rejects.toThrow(
      /worktree/,
    );
    await expect(
      m.ensure(ensureInput({ worktreePath: path.join(root, "work") })),
    ).rejects.toThrow(/worktree/);
    await expect(
      m.ensure(ensureInput({ worktreePath: path.join(root, "work", "..", "repos") })),
    ).rejects.toThrow(/worktree/);
    await expect(m.ensure(ensureInput({ repositoryName: "../etc" }))).rejects.toThrow(
      /repository/,
    );
    await expect(m.ensure(ensureInput({ repositoryName: "a/b" }))).rejects.toThrow(
      /repository/,
    );
    expect(docker.calls.filter((c) => c.args[0] === "run")).toEqual([]);
  });

  it.each(["HOME", "PATH", "DOCKER_HOST", "DOCKER_CONFIG", "A=B", "", "1X", "X Y"])(
    "rejects env name %j without running docker",
    async (name) => {
      const docker = fakeDocker(freshHost());
      await expect(
        manager(docker.run).ensure(ensureInput({ env: { [name]: "v" } })),
      ).rejects.toThrow(TypeError);
      expect(docker.calls.filter((c) => c.args[0] === "run")).toEqual([]);
    },
  );

  it("reuses a running container without creating anything", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "container" && args[1] === "inspect" ? RUNNING : undefined,
    );
    const handle = await manager(docker.run).ensure(ensureInput());
    expect(handle.created).toBe(false);
    expect(docker.verbs()).toEqual(["container inspect"]);
    expect(docker.calls[0]!.args).toEqual([
      "container",
      "inspect",
      "--format",
      "{{json .State}}",
      `orchestra-exec-${EXEC}`,
    ]);
    expect(existsSync(path.join(root, "agent-home", TASK))).toBe(true);
  });

  it.each([
    ["exited", EXITED],
    [
      "paused",
      { exitCode: 0, stdout: '{"Status":"paused","Running":true,"Paused":true,"Restarting":false}' },
    ],
  ])("removes a %s container and recreates it with the same mounts", async (_label, state) => {
    let firstInspect = true;
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] !== "container" || args[1] !== "inspect" || !firstInspect) return undefined;
        firstInspect = false;
        return state;
      }),
    );
    const handle = await manager(docker.run).ensure(ensureInput());
    expect(handle.created).toBe(true);
    expect(docker.verbs()).toEqual([
      "container inspect",
      "rm -f",
      "network inspect",
      "run -d",
      "container inspect",
    ]);
    expect(docker.calls[1]!.args).toEqual(["rm", "-f", "-v", `orchestra-exec-${EXEC}`]);
  });

  it("creates the orchestra-agents bridge network when it is missing", async () => {
    let created = false;
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] === "network" && args[1] === "inspect" && !created) {
          return { exitCode: 1, stdout: "[]", stderr: "Error response from daemon: network orchestra-agents not found" };
        }
        if (args[0] === "network" && args[1] === "create") {
          created = true;
          return { stdout: "netid\n" };
        }
        return undefined;
      }),
    );
    await manager(docker.run).ensure(ensureInput());
    const create = docker.calls.find((c) => c.args[0] === "network" && c.args[1] === "create")!;
    expect(create.args).toEqual(["network", "create", "--driver", "bridge", "orchestra-agents"]);
    expect(docker.verbs().indexOf("network create")).toBeLessThan(docker.verbs().indexOf("run -d"));
  });

  it("treats a concurrent network create as success", async () => {
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          return { exitCode: 1, stderr: "Error response from daemon: network orchestra-agents not found" };
        }
        if (args[0] === "network" && args[1] === "create") {
          return { exitCode: 1, stderr: "Error response from daemon: network with name orchestra-agents already exists" };
        }
        return undefined;
      }),
    );
    await expect(manager(docker.run).ensure(ensureInput())).resolves.toMatchObject({ created: true });
  });

  it("returns the running container when a concurrent ensure won the name", async () => {
    let inspects = 0;
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] === "container" && args[1] === "inspect") {
          return ++inspects === 1 ? NOT_FOUND : RUNNING;
        }
        if (args[0] === "run") {
          return {
            exitCode: 125,
            stderr: `docker: Error response from daemon: Conflict. The container name "/orchestra-exec-${EXEC}" is already in use by container "x".`,
          };
        }
        return undefined;
      }),
    );
    await expect(manager(docker.run).ensure(ensureInput())).resolves.toMatchObject({
      created: false,
    });
  });

  it("maps a failed create to DockerError with reason failed and the exit code", async () => {
    const docker = fakeDocker(
      freshHost((args) =>
        args[0] === "run"
          ? { exitCode: 125, stderr: "docker: Error response from daemon: No such image: orchestra/agent:0.0.1" }
          : undefined,
      ),
    );
    const err = await manager(docker.run).ensure(ensureInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ reason: "failed", exitCode: 125, code: "DOCKER_FAILED" });
    expect((err as DockerError).message).toMatch(/No such image/);
    expect((err as DockerError).message).not.toContain("SECRETVALUE");
  });

  it("raises DockerError instead of reporting success when the container is not running right after create", async () => {
    let inspects = 0;
    const docker = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        inspects += 1;
        return inspects === 1 ? NOT_FOUND : EXITED;
      }
      if (args[0] === "network" && args[1] === "inspect") return NETWORK_OK;
      if (args[0] === "run") return { stdout: "abc123\n" };
      return undefined;
    });
    const err = await manager(docker.run).ensure(ensureInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).message).toMatch(/exited immediately/);
  });

  it.each([
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "failed to connect to the docker API at unix:///x.sock; check if the path is correct and if the daemon is running",
    "error during connect: Get \"http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/containers/json\"",
  ])("maps a daemon-down message to DockerError reason unavailable: %s", async (stderr) => {
    const docker = fakeDocker(() => ({ exitCode: 1, stderr }));
    const err = await manager(docker.run).ensure(ensureInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).reason).toBe("unavailable");
  });

  it("passes a DockerError from the runner (CLI missing) through unchanged", async () => {
    const missing = new DockerError({ reason: "unavailable", args: ["container"], exitCode: null, stderr: "spawn docker ENOENT" });
    const docker = fakeDocker(() => missing);
    await expect(manager(docker.run).ensure(ensureInput())).rejects.toBe(missing);
  });

  it("gives every docker call a positive timeout", async () => {
    const docker = fakeDocker(freshHost());
    const m = manager(docker.run);
    await m.ensure(ensureInput());
    await m.remove(EXEC);
    await m.networkGateway();
    expect(docker.calls.length).toBeGreaterThan(4);
    for (const call of docker.calls) expect(call.options.timeoutMs).toBeGreaterThan(0);
  });

  it("runs as the worker's own uid and gid by default", async () => {
    const docker = fakeDocker(freshHost());
    const m = new ContainerManager({ workspaceRoot: root, image: IMAGE, cpus: 1.5, memory: "512m", owner: OWNER, run: docker.run });
    await m.ensure(ensureInput());
    const args = docker.calls.find((c) => c.args[0] === "run")!.args;
    expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(args[args.indexOf("--cpus") + 1]).toBe("1.5");
    expect(args[args.indexOf("--memory") + 1]).toBe("512m");
  });
});

describe("ContainerManager.remove", () => {
  it("force-removes the execution's container", async () => {
    const docker = fakeDocker();
    await manager(docker.run).remove(EXEC);
    expect(docker.calls.map((c) => c.args)).toEqual([["rm", "-f", "-v", `orchestra-exec-${EXEC}`]]);
  });

  it("is idempotent when the container is already gone", async () => {
    const docker = fakeDocker(() => NOT_FOUND);
    await expect(manager(docker.run).remove(EXEC)).resolves.toBeUndefined();
  });

  it("raises DockerError for any other failure", async () => {
    const docker = fakeDocker(() => ({ exitCode: 1, stderr: "Error response from daemon: removal in progress" }));
    await expect(manager(docker.run).remove(EXEC)).rejects.toBeInstanceOf(DockerError);
  });
});

describe("ContainerManager.networkGateway", () => {
  it("returns the network's IPv4 gateway", async () => {
    const docker = fakeDocker(() => ({
      stdout: '[{"Subnet":"fd00::/64","Gateway":"fd00::1"},{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]',
    }));
    expect(await manager(docker.run).networkGateway()).toBe("172.30.0.1");
    expect(docker.calls.at(-1)!.args).toEqual([
      "network",
      "inspect",
      "--format",
      "{{json .IPAM.Config}}",
      "orchestra-agents",
    ]);
  });

  it("creates the network first when it is missing", async () => {
    let created = false;
    const docker = fakeDocker((args) => {
      if (args[1] === "inspect" && !created) return { exitCode: 1, stderr: "Error response from daemon: network orchestra-agents not found" };
      if (args[1] === "create") {
        created = true;
        return undefined;
      }
      return NETWORK_OK;
    });
    expect(await manager(docker.run).networkGateway()).toBe("172.30.0.1");
    expect(docker.verbs()).toContain("network create");
  });

  it("returns null when the network has no IPv4 gateway", async () => {
    const docker = fakeDocker(() => ({ stdout: "[]" }));
    expect(await manager(docker.run).networkGateway()).toBeNull();
  });
});

describe("dockerExecutionContainers", () => {
  it("lists only containers carrying the orchestra.execution label and this deployment's orchestra.owner label", async () => {
    const docker = fakeDocker(() => ({
      stdout: [
        `c1\torchestra-exec-${EXEC}\t${EXEC}\t${TASK}\t${OWNER}`,
        `c2\tstray\tnot-a-uuid\t\t${OWNER}`,
        "",
      ].join("\n"),
    }));
    const ops = dockerExecutionContainers({ owner: OWNER, run: docker.run });

    expect(ops.owner).toBe(OWNER);
    expect(await ops.list()).toEqual([
      { id: "c1", name: `orchestra-exec-${EXEC}`, executionId: EXEC, taskId: TASK, owner: OWNER },
      { id: "c2", name: "stray", executionId: "not-a-uuid", taskId: null, owner: OWNER },
    ]);
    expect(docker.calls[0]!.args).toEqual([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=orchestra.execution",
      "--filter",
      `label=orchestra.owner=${OWNER}`,
      "--format",
      '{{.ID}}\t{{.Names}}\t{{.Label "orchestra.execution"}}\t{{.Label "orchestra.task"}}\t{{.Label "orchestra.owner"}}',
    ]);
    expect(docker.calls[0]!.options.timeoutMs).toBeGreaterThan(0);
  });

  it("drops a listed row whose owner label is absent or another deployment's", async () => {
    const docker = fakeDocker(() => ({
      stdout: [
        `c1\tmine\t${EXEC}\t${TASK}\t${OWNER}`,
        `c2\ttheirs\t${EXEC}\t${TASK}\tffffffffffffffffffffffffffffffff`,
        `c3\tnobody\t${EXEC}\t${TASK}\t`,
      ].join("\n"),
    }));
    const listed = await dockerExecutionContainers({ owner: OWNER, run: docker.run }).list();
    expect(listed.map((c) => c.id)).toEqual(["c1"]);
  });

  it.each(["", "a b", "a,b", "a=b", "-x", "x\ny"])("rejects owner %j", (owner) => {
    expect(() => dockerExecutionContainers({ owner, run: fakeDocker().run })).toThrow(TypeError);
    expect(() => manager(fakeDocker().run, { owner })).toThrow(TypeError);
  });

  it("removes by execution id and by container id, idempotently", async () => {
    const docker = fakeDocker(() => NOT_FOUND);
    const ops = dockerExecutionContainers({ owner: OWNER, run: docker.run });
    await ops.removeForExecution(EXEC);
    await ops.remove("c1");
    expect(docker.calls.map((c) => c.args)).toEqual([
      ["rm", "-f", "-v", `orchestra-exec-${EXEC}`],
      ["rm", "-f", "-v", "c1"],
    ]);
  });

  it("raises DockerError when listing fails", async () => {
    const docker = fakeDocker(() => ({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" }));
    await expect(
      dockerExecutionContainers({ owner: OWNER, run: docker.run }).list(),
    ).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});

describe("the per-execution container lock and ensure mark (§6.6, §9.9 Recreation)", () => {
  const exec = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let n = 0;

  it("ensure records a new mark on every call, and remove clears it", async () => {
    const id = exec(++n);
    const docker = fakeDocker(freshHost());
    const m = manager(docker.run);
    expect(ensureMark(id)).toBe(0);

    await m.ensure(ensureInput({ executionId: id }));
    const first = ensureMark(id);
    expect(first).toBeGreaterThan(0);
    await m.ensure(ensureInput({ executionId: id }));
    expect(ensureMark(id)).toBeGreaterThan(first);

    await m.remove(id);
    expect(ensureMark(id)).toBe(0);
  });

  it("remove clears the mark even when docker fails", async () => {
    const id = exec(++n);
    const m = manager(fakeDocker(freshHost()).run);
    await m.ensure(ensureInput({ executionId: id }));
    const failing = manager(fakeDocker(() => ({ exitCode: 1, stderr: "Error response from daemon: boom" })).run);
    await expect(failing.remove(id)).rejects.toBeInstanceOf(DockerError);
    expect(ensureMark(id)).toBe(0);
  });

  it("ensure waits while a removal holds the execution's lock, then recreates the removed container", async () => {
    const id = exec(++n);
    let removed = false;
    let created = false;
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] === "run") {
          created = true;
          return undefined;
        }
        if (args[0] !== "container" || args[1] !== "inspect") return undefined;
        if (!removed) return RUNNING;
        return created ? RUNNING : NOT_FOUND;
      }),
    );
    const m = manager(docker.run);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const removal = withExecutionContainerLock(id, async () => {
      locked();
      await held;
      removed = true;
    });
    await isLocked;
    const ensured = m.ensure(ensureInput({ executionId: id }));
    for (let i = 0; i < 5; i++) await flush();
    expect(docker.calls).toEqual([]);

    release();
    await removal;
    const handle = await ensured;
    expect(handle.created).toBe(true);
    expect(docker.verbs()).toEqual(["container inspect", "network inspect", "run -d", "container inspect"]);
  });

  it("locks are per execution: another execution's ensure does not wait", async () => {
    const a = exec(++n);
    const b = exec(++n);
    const docker = fakeDocker(freshHost());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const removal = withExecutionContainerLock(a, () => held);
    await expect(manager(docker.run).ensure(ensureInput({ executionId: b }))).resolves.toMatchObject({
      created: true,
    });
    release();
    await removal;
  });

  it("recreating a stopped container inside ensure does not deadlock on the lock ensure holds", async () => {
    const id = exec(++n);
    let firstInspect = true;
    const docker = fakeDocker(
      freshHost((args) => {
        if (args[0] !== "container" || args[1] !== "inspect" || !firstInspect) return undefined;
        firstInspect = false;
        return EXITED;
      }),
    );
    await expect(manager(docker.run).ensure(ensureInput({ executionId: id }))).resolves.toMatchObject({
      created: true,
    });
    expect(ensureMark(id)).toBeGreaterThan(0);
  });
});

describe("ContainerManager.spawner (design.md §9.9 Launching processes)", () => {
  const WORKER_ENV = {
    PATH: "/usr/bin",
    HOME: "/Users/operator",
    DATABASE_URL: "postgres://secret",
    JIRA_API_TOKEN: "jira-secret",
    GITHUB_TOKEN: SECRET_GH,
  };

  function setup(onKill?: (client: FakeClient, signal: string) => void, reply?: (args: string[]) => Reply) {
    const docker = fakeDocker(reply);
    const clients = fakeSpawner(onKill);
    const m = manager(docker.run, { spawnClient: clients.spawn, hostEnv: WORKER_ENV });
    return { docker, clients, spawn: m.spawner(`orchestra-exec-${EXEC}`) };
  }

  it("runs docker exec -i -w <cwd> -e <names> <container> orchestra-launch <turn> -- <command> <args>", () => {
    const { clients, spawn } = setup();
    spawn("claude", ["--print", "--verbose"], {
      cwd: "/ws/work/x",
      env: { ...WORKER_ENV, ORCHESTRA_TOKEN: SECRET_TURN, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
    });

    const client = clients.clients[0]!;
    expect(client.command).toBe("docker");
    const turn = client.args[client.args.indexOf("orchestra-launch") + 1]!;
    expect(client.args).toEqual([
      "exec",
      "-i",
      "-w",
      "/ws/work/x",
      "-e",
      "ORCHESTRA_TOKEN",
      "-e",
      "CLAUDE_CODE_ENTRYPOINT",
      `orchestra-exec-${EXEC}`,
      "orchestra-launch",
      turn,
      "--",
      "claude",
      "--print",
      "--verbose",
    ]);
    expect(turn).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(client.args.join(" ")).not.toContain("SECRETVALUE");
  });

  it("passes only per-spawn variables the worker's own environment does not define", () => {
    const { clients, spawn } = setup();
    spawn("codex", [], {
      cwd: "/w",
      env: { ...WORKER_ENV, ORCHESTRA_TOKEN: SECRET_TURN, HOME: "/elsewhere", PATH: "/x", DOCKER_HOST: "tcp://evil", UNDEF: undefined },
    });
    const env = clients.clients[0]!.options.env;
    expect(env.ORCHESTRA_TOKEN).toBe(SECRET_TURN);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JIRA_API_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.UNDEF).toBeUndefined();
    // The docker client's own HOME and PATH (for its config), never the caller's.
    expect(env.HOME).toBe("/Users/operator");
    expect(env.PATH).toBe("/usr/bin");
    const names = clients.clients[0]!.args.filter((_, i, a) => a[i - 1] === "-e");
    expect(names).toEqual(["ORCHESTRA_TOKEN"]);
  });

  it("uses a unique turn id per spawn", () => {
    const { clients, spawn } = setup();
    spawn("a", [], { cwd: "/w", env: {} });
    spawn("a", [], { cwd: "/w", env: {} });
    const turns = clients.clients.map((c) => c.args[c.args.indexOf("orchestra-launch") + 1]);
    expect(new Set(turns).size).toBe(2);
  });

  it("passes stdin, stdout, stderr and the exit code through", async () => {
    const { clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    const client = clients.clients[0]!;

    const stdinSeen: string[] = [];
    (client.stdin as PassThrough).on("data", (c: Buffer) => stdinSeen.push(c.toString()));
    proc.stdin.write("hello");
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c.toString()));
    proc.stderr.on("data", (c: Buffer) => err.push(c.toString()));
    (client.stdout as PassThrough).write("out-1");
    (client.stderr as PassThrough).write("warn: agent said so");
    client.finish({ code: 3, signal: null });

    await expect(proc.exit).resolves.toEqual({ code: 3, signal: null });
    await flush();
    expect(stdinSeen.join("")).toBe("hello");
    expect(out.join("")).toBe("out-1");
    expect(err.join("")).toBe("warn: agent said so");
  });

  it("kill signals the process group from the pid file through docker exec, then kills the client", async () => {
    const order: string[] = [];
    const { docker, clients, spawn } = setup(
      (client, signal) => {
        order.push(`client ${signal}`);
        client.finish({ code: null, signal });
      },
      (args) => {
        if (args[0] === "exec") order.push("group kill");
        return undefined;
      },
    );
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    const turn = clients.clients[0]!.args[clients.clients[0]!.args.indexOf("orchestra-launch") + 1]!;

    proc.kill();
    await expect(proc.exit).resolves.toEqual({ code: null, signal: "SIGKILL" });

    const kill = docker.calls.find((c) => c.args[0] === "exec")!;
    expect(kill.args.slice(0, 4)).toEqual(["exec", `orchestra-exec-${EXEC}`, "sh", "-c"]);
    expect(kill.args.slice(-3)).toEqual(["sh", turn, "KILL"]);
    expect(kill.args[4]).toContain("/run/orchestra/");
    expect(kill.options.timeoutMs).toBeGreaterThan(0);
    expect(order).toEqual(["group kill", "client SIGKILL"]);
  });

  it("a SIGTERM that reached the group leaves the client to exit with it, so a later SIGKILL still applies", async () => {
    const { docker, clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    proc.kill("SIGTERM");
    await flush();
    await flush();
    expect(docker.calls.find((c) => c.args[0] === "exec")!.args.at(-1)).toBe("TERM");
    expect(clients.clients[0]!.killed).toEqual([]);
    proc.kill("SIGKILL");
    await flush();
    await flush();
    expect(clients.clients[0]!.killed).toEqual(["SIGKILL"]);
  });

  it("falls back to killing the client when the in-container kill fails", async () => {
    const { clients, spawn } = setup(undefined, (args) =>
      args[0] === "exec" ? { exitCode: 3, stderr: "" } : undefined,
    );
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    proc.kill("SIGTERM");
    await flush();
    await flush();
    expect(clients.clients[0]!.killed).toEqual(["SIGTERM"]);
  });

  it("falls back to killing the client when docker itself fails during kill", async () => {
    const { clients, spawn } = setup(undefined, (args) =>
      args[0] === "exec" ? new DockerError({ reason: "timeout", args, exitCode: null, stderr: "" }) : undefined,
    );
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    proc.kill();
    await flush();
    await flush();
    expect(clients.clients[0]!.killed).toEqual(["SIGKILL"]);
  });

  it("does nothing once the process has exited", async () => {
    const { docker, clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    clients.clients[0]!.finish({ code: 0, signal: null });
    await proc.exit;
    proc.kill();
    await flush();
    expect(docker.calls).toEqual([]);
    expect(clients.clients[0]!.killed).toEqual([]);
  });

  it("rejects exit with DockerError when docker exec itself failed, and still shows its stderr", async () => {
    const { clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    const err: string[] = [];
    proc.stderr.on("data", (c: Buffer) => err.push(c.toString()));
    (clients.clients[0]!.stderr as PassThrough).write(
      `Error response from daemon: container orchestra-exec-${EXEC} is not running\n`,
    );
    clients.clients[0]!.finish({ code: 1, signal: null });

    const e = await proc.exit.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DockerError);
    expect((e as DockerError).reason).toBe("failed");
    await flush();
    expect(err.join("")).toMatch(/is not running/);
  });

  it("rejects exit with DockerError reason unavailable when the docker client cannot start", async () => {
    const { clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    clients.clients[0]!.fail(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    const e = await proc.exit.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DockerError);
    expect((e as DockerError).reason).toBe("unavailable");
  });

  it("treats a non-zero exit with ordinary stderr as the command's own exit", async () => {
    const { clients, spawn } = setup();
    const proc = spawn("a", [], { cwd: "/w", env: {} });
    (clients.clients[0]!.stderr as PassThrough).write("Error: tests failed\n");
    clients.clients[0]!.finish({ code: 1, signal: null });
    await expect(proc.exit).resolves.toEqual({ code: 1, signal: null });
  });
});

describe("ContainerManager.runShell (setup_command)", () => {
  it("runs sh -c <command> in the worktree through the launcher and captures output and exit code", async () => {
    const clients = fakeSpawner();
    const docker = fakeDocker();
    const m = manager(docker.run, { spawnClient: clients.spawn, hostEnv: {} });

    const done = m.runShell({
      container: `orchestra-exec-${EXEC}`,
      cwd: "/ws/work/x",
      command: "npm ci && echo ok",
      timeoutMs: 5000,
    });
    await flush();
    const client = clients.clients[0]!;
    const launcher = client.args.indexOf("orchestra-launch");
    expect(client.args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/ws/work/x"]);
    expect(client.args[launcher - 1]).toBe(`orchestra-exec-${EXEC}`);
    expect(client.args.slice(launcher + 2)).toEqual(["--", "sh", "-c", "npm ci && echo ok"]);
    (client.stdout as PassThrough).write("installing\n");
    (client.stderr as PassThrough).write("warn\n");
    client.finish({ code: 2, signal: null });

    const result = await done;
    expect(result).toMatchObject({ exitCode: 2, signal: null, timedOut: false });
    expect(result.tail).toContain("installing");
    expect(result.tail).toContain("warn");
  });

  it("kills the command's process group when the timeout elapses", async () => {
    const clients = fakeSpawner((client, signal) => client.finish({ code: null, signal }));
    const docker = fakeDocker();
    const m = manager(docker.run, { spawnClient: clients.spawn, hostEnv: {} });

    const result = await m.runShell({
      container: `orchestra-exec-${EXEC}`,
      cwd: "/w",
      command: "sleep 100",
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGKILL" });
    expect(docker.calls.filter((c) => c.args[0] === "exec")).toHaveLength(1);
  });

  it("rejects with DockerError when docker exec itself fails", async () => {
    const clients = fakeSpawner();
    const m = manager(fakeDocker().run, { spawnClient: clients.spawn, hostEnv: {} });
    const done = m.runShell({ container: "c", cwd: "/w", command: "true", timeoutMs: 5000 });
    await flush();
    (clients.clients[0]!.stderr as PassThrough).write("Error response from daemon: No such container: c\n");
    clients.clients[0]!.finish({ code: 1, signal: null });
    await expect(done).rejects.toBeInstanceOf(DockerError);
  });
});

describe("createDockerRunner", () => {
  let bin: string;

  beforeAll(async () => {
    bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, "fake-docker"),
      '#!/bin/sh\nif [ "$1" = sleep ]; then exec sleep 30; fi\nif [ "$1" = fail ]; then echo "boom" >&2; exit 4; fi\nenv\n',
      { mode: 0o755 },
    );
  });

  it("raises DockerError reason unavailable when the CLI is missing", async () => {
    const run = createDockerRunner({ binary: path.join(tmp, "no-such-docker") });
    const err = await run(["info"], { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).reason).toBe("unavailable");
  });

  it("raises DockerError reason timeout and kills the client when the call overruns", async () => {
    const run = createDockerRunner({ binary: path.join(bin, "fake-docker") });
    const started = Date.now();
    const err = await run(["sleep"], { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("resolves a non-zero exit with its code and stderr", async () => {
    const run = createDockerRunner({ binary: path.join(bin, "fake-docker") });
    await expect(run(["fail"], { timeoutMs: 5000 })).resolves.toMatchObject({
      exitCode: 4,
      stderr: "boom\n",
    });
  });

  it("gives the client only its own settings plus the passed variables, never the rest of the worker environment", async () => {
    const run = createDockerRunner({
      binary: path.join(bin, "fake-docker"),
      hostEnv: {
        PATH: process.env.PATH,
        HOME: "/Users/operator",
        DOCKER_CONTEXT: "desktop-linux",
        DATABASE_URL: "postgres://secret",
        JIRA_API_TOKEN: "jira-secret",
      },
    });
    const { stdout } = await run(["env"], {
      timeoutMs: 5000,
      env: { GITHUB_TOKEN: SECRET_GH },
    });
    expect(stdout).toContain(`GITHUB_TOKEN=${SECRET_GH}`);
    expect(stdout).toContain("HOME=/Users/operator");
    expect(stdout).toContain("DOCKER_CONTEXT=desktop-linux");
    expect(stdout).not.toContain("DATABASE_URL");
    expect(stdout).not.toContain("JIRA_API_TOKEN");
  });
});
